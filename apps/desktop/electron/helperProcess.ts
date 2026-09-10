import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { app } from 'electron';

/**
 * Owns the Swift helper child process (newline-delimited JSON over stdio:
 * {id,method,params} → {id,result|error}) and exposes one request
 * function to the rest of main. Two consumers: the renderer-facing
 * model:* IPC (modelHelper.ts) and the backend's RemindersClient
 * (remindersClient.ts) — both ride the same process.
 */

/**
 * Per-method budgets: status must fail fast (a hung helper must not stall
 * an availability check), generation and transcription get the
 * model-scale budget, prepareSpeech legitimately downloads locale assets
 * for minutes on first use, and EventKit calls are local (the one slow
 * case is the TCC prompt, which waits on the user).
 */
const TIMEOUTS_MS: Record<string, number> = {
  'contacts.requestAccess': 600_000,
  'contacts.snapshot': 30_000,
  'contacts.status': 10_000,
  generateJson: 120_000,
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

interface PendingRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

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

let child: Helper | null = null;
let lastSpawnFailedAt = 0;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();
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

const failAllPending = (message: string) => {
  for (const [, request] of pending) {
    clearTimeout(request.timer);
    request.reject(new Error(message));
  }
  pending.clear();
};

const ensureHelper = (): Helper | null => {
  if (child) {
    return child;
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
  child = spawned;
  // A write racing the child's death emits 'error' on stdin; unhandled,
  // that is an uncaught exception in the MAIN process. The exit handler
  // already fails pending requests, so swallowing here is correct — the
  // racing request resolves via its timeout at worst.
  spawned.stdin.on('error', () => undefined);
  createInterface({ input: spawned.stdout }).on('line', (line) => {
    let parsed: { error?: string; event?: string; id?: number; result?: unknown };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      return;
    }
    if (parsed.id === undefined && typeof parsed.event === 'string') {
      for (const listener of eventListeners.get(parsed.event) ?? []) {
        listener();
      }
      return;
    }
    const request = parsed.id === undefined ? undefined : pending.get(parsed.id);
    if (!request) {
      return;
    }
    pending.delete(parsed.id!);
    clearTimeout(request.timer);
    if (parsed.error !== undefined) {
      request.reject(new Error(parsed.error));
    } else {
      request.resolve(parsed.result);
    }
  });
  spawned.on('exit', () => {
    if (child === spawned) {
      child = null;
      lastSpawnFailedAt = Date.now();
    }
    failAllPending('model helper exited');
  });
  spawned.on('error', () => {
    if (child === spawned) {
      child = null;
      lastSpawnFailedAt = Date.now();
    }
    failAllPending('model helper failed to start');
  });
  return spawned;
};

export const HELPER_UNAVAILABLE = 'model helper unavailable';

export const callHelper = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
  const helper = ensureHelper();
  if (!helper) {
    return Promise.reject(new Error(HELPER_UNAVAILABLE));
  }
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('model helper timed out'));
    }, TIMEOUTS_MS[method] ?? DEFAULT_TIMEOUT_MS);
    pending.set(id, { reject, resolve, timer });
    helper.stdin.write(`${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`);
  });
};

/** Wire once from main: kill the child when the app quits. */
export const registerHelperLifecycle = (): void => {
  app.on('will-quit', () => {
    child?.kill();
    child = null;
  });
};
