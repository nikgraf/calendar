import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { app, ipcMain, systemPreferences } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Owns the Swift model helper (Foundation Models + SpeechAnalyzer over a
 * newline-delimited JSON stdio protocol) and exposes it to the renderer
 * over plain preload IPC — model calls are a window-level concern, not
 * calendar data, so they stay off the rpc seam by design.
 */

/**
 * Per-method budgets: status must fail fast (a hung helper must not stall
 * the bar's availability check), generation and transcription get the
 * model-scale budget, and prepareSpeech legitimately downloads locale
 * assets for minutes on first use.
 */
const TIMEOUTS_MS: Record<string, number> = {
  generateJson: 120_000,
  prepareSpeech: 600_000,
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

type Helper = ChildProcessByStdio<Writable, Readable, null>;

let child: Helper | null = null;
let lastSpawnFailedAt = 0;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

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
  createInterface({ input: spawned.stdout }).on('line', (line) => {
    let parsed: { error?: string; id?: number; result?: unknown };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
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

const call = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
  const helper = ensureHelper();
  if (!helper) {
    return Promise.reject(new Error('model helper unavailable'));
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

export const registerModelHelper = (): void => {
  ipcMain.handle('model:status', async () => {
    try {
      return await call('status');
    } catch {
      // No helper binary or a crash: same shape the renderer maps to
      // 'missing-module' / 'unavailable'.
      return { detail: 'helperUnavailable', status: 'unavailable' };
    }
  });
  ipcMain.handle('model:generate', (_event, schema: unknown, prompt: unknown) =>
    call('generateJson', { prompt, schema }),
  );
  ipcMain.handle('model:prepare-speech', async (_event, locale: unknown) => {
    // The OS mic prompt needs a main-process ask; denial is a typed state,
    // not an exception, so the renderer can map MicrophoneDeniedError.
    const granted = await systemPreferences.askForMediaAccess('microphone');
    if (!granted) {
      return { denied: true };
    }
    return call('prepareSpeech', { locale });
  });
  ipcMain.handle('model:transcribe', (_event, audioBase64: unknown, locale: unknown) =>
    call('transcribe', { audioBase64, locale }),
  );
  app.on('will-quit', () => {
    child?.kill();
    child = null;
  });
};
