import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { BridgeTransport } from '@calendar/core';
import { app } from 'electron';
import { type HelperRequests, makeHelperRequests } from './helperRequests.ts';

/**
 * Owns the Swift helper child process (newline-delimited JSON over stdio:
 * {id,method,params} → {id,result|error}) and exposes one request
 * function to the rest of main. Consumers: the renderer-facing model:*
 * IPC (modelHelper.ts) and the backend's native clients (Reminders,
 * Contacts, Geo, Apple Calendar) — all ride the same process.
 */

/**
 * Per-method budgets: status must fail fast (a hung helper must not stall
 * an availability check), generation and transcription get the
 * model-scale budget, prepareSpeech legitimately downloads locale assets
 * for minutes on first use, and EventKit calls are local (the one slow
 * case is the TCC prompt, which waits on the user).
 */
const TIMEOUTS_MS: Record<string, number> = {
  'calendar.create': 15_000,
  'calendar.delete': 15_000,
  // A range query expands every series in it; years of history is still local.
  'calendar.events': 30_000,
  'calendar.listCalendars': 15_000,
  'calendar.move': 15_000,
  'calendar.requestAccess': 600_000,
  'calendar.series': 15_000,
  'calendar.setColor': 15_000,
  'calendar.status': 10_000,
  'calendar.update': 15_000,
  'contacts.birthdays': 30_000,
  'contacts.requestAccess': 600_000,
  'contacts.snapshot': 30_000,
  'contacts.status': 10_000,
  generateJson: 120_000,
  // MapKit round-trips to Apple's servers; a slow network must not hang the editor.
  'geo.resolve': 15_000,
  'geo.search': 10_000,
  'geo.snapshot': 20_000,
  // Vision on a full-resolution screenshot; local, but a document pass is not instant.
  'ocr.recognizeText': 60_000,
  prepareSpeech: 600_000,
  'reminders.create': 15_000,
  'reminders.delete': 15_000,
  'reminders.list': 30_000,
  'reminders.listLists': 15_000,
  'reminders.requestAccess': 600_000,
  'reminders.setCompleted': 15_000,
  'reminders.status': 10_000,
  'reminders.update': 15_000,
  status: 10_000,
  transcribe: 120_000,
};
const DEFAULT_TIMEOUT_MS = 120_000;
/** Crash-looping helpers back off instead of burning CPU. */
const RESTART_BACKOFF_MS = 5000;

const helperPath = (): string | null => {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'solunivo-model-helper')]
    : [
        // Dev: the SPM build output, either configuration.
        join(__dirname, '..', 'helper', '.build', 'release', 'solunivo-model-helper'),
        join(__dirname, '..', 'helper', '.build', 'debug', 'solunivo-model-helper'),
      ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

/** True when a helper binary exists for this build (dev or packaged). */
export const helperAvailable = (): boolean => helperPath() !== null;

type Helper = ChildProcessByStdio<Writable, Readable, null>;

/** The running helper and the requests in flight to it. */
let child: { readonly process: Helper; readonly requests: HelperRequests } | null = null;
let lastSpawnFailedAt = 0;
/** Subscribers to the helper's unsolicited `{"event": name}` lines. */
const eventListeners = new Map<string, Set<() => void>>();

export const onHelperEvent = (name: string, listener: () => void): (() => void) => {
  const listeners = eventListeners.get(name) ?? new Set<() => void>();
  listeners.add(listener);
  eventListeners.set(name, listeners);
  return () => {
    listeners.delete(listener);
  };
};

const ensureHelper = (): HelperRequests | null => {
  if (child) {
    return child.requests;
  }
  if (Date.now() - lastSpawnFailedAt < RESTART_BACKOFF_MS) {
    return null;
  }
  const binary = helperPath();
  if (!binary) {
    lastSpawnFailedAt = Date.now();
    return null;
  }
  // stderr ignored deliberately: an unread pipe fills its buffer and
  // blocks the child if anything (framework warnings included) writes.
  const spawned = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const requests = makeHelperRequests({
    // Only a helper that stopped answering altogether: the next call
    // respawns it (after the restart backoff), and the exit handler fails
    // what was still waiting.
    kill: () => {
      if (child?.process === spawned) {
        spawned.kill();
      }
    },
    timeoutFor: (method) => TIMEOUTS_MS[method] ?? DEFAULT_TIMEOUT_MS,
    write: (line) => {
      spawned.stdin.write(line);
    },
  });
  child = { process: spawned, requests };
  // A write racing the child's death emits 'error' on stdin; unhandled,
  // that is an uncaught exception in the MAIN process. The exit handler
  // already fails pending requests, so swallowing here is correct — the
  // racing request resolves via its timeout at worst.
  spawned.stdin.on('error', () => undefined);
  createInterface({ input: spawned.stdout }).on('line', (line) => {
    const event = requests.receive(line);
    if (event !== undefined) {
      for (const listener of eventListeners.get(event) ?? []) {
        listener();
      }
    }
  });
  const ended = (message: string) => {
    if (child?.process === spawned) {
      child = null;
      lastSpawnFailedAt = Date.now();
    }
    requests.failAll(message);
  };
  spawned.on('exit', () => ended('model helper exited'));
  spawned.on('error', () => ended('model helper failed to start'));
  return requests;
};

export const HELPER_UNAVAILABLE = 'model helper unavailable';

export const callHelper = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
  const requests = ensureHelper();
  return requests ? requests.call(method, params) : Promise.reject(new Error(HELPER_UNAVAILABLE));
};

/**
 * The helper as a bridge transport for the Reminders, Contacts and geo
 * clients, or the reason there is none. CALENDAR_REMINDERS=off /
 * CALENDAR_CONTACTS=off / CALENDAR_GEO=off make a bridge unreachable on
 * purpose: the e2e suite seeds Apple rows straight into SQLite and must
 * never let a real sync (or a TCC prompt, or a MapKit network call)
 * touch a developer's data or make a run depend on the network.
 */
export const helperTransport = (
  killSwitch: string,
): BridgeTransport | { readonly unavailable: string } =>
  process.env[killSwitch] === 'off'
    ? { unavailable: `disabled by ${killSwitch}=off` }
    : helperAvailable()
      ? { invoke: callHelper, subscribe: onHelperEvent }
      : { unavailable: 'helper binary missing — run build:helper' };

/** Wire once from main: kill the child when the app quits. */
export const registerHelperLifecycle = (): void => {
  app.on('will-quit', () => {
    child?.process.kill();
    child = null;
  });
};
