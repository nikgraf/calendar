import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal persistent log for the main process: console.warn/error (which is
 * where Effect's default logger writes) and fatal process events are teed
 * into userData/logs/main.log, rotated once past ~1 MB. Gives failed syncs
 * and crashes a paper trail without a logging framework.
 */

const MAX_BYTES = 1024 * 1024;

let logPath: string | null = null;

const appendLog = (scope: string, parts: ReadonlyArray<unknown>): void => {
  if (!logPath) {
    return;
  }
  try {
    if (existsSync(logPath) && statSync(logPath).size > MAX_BYTES) {
      renameSync(logPath, `${logPath}.old`);
    }
    const text = parts
      .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
      .join(' ');
    appendFileSync(logPath, `${new Date().toISOString()} ${scope} ${text}\n`);
  } catch {
    // Logging must never take the app down.
  }
};

export const logRendererError = (text: string): void => {
  appendLog('[renderer]', [text]);
};

export const initFileLogging = (userDataDir: string): void => {
  const logDir = join(userDataDir, 'logs');
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    return;
  }
  logPath = join(logDir, 'main.log');

  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...parts: Array<unknown>) => {
      appendLog(`[${level}]`, parts);
      original(...parts);
    };
  }
  process.on('uncaughtException', (error) => {
    appendLog('[fatal]', [String(error), error.stack ?? '']);
  });
  process.on('unhandledRejection', (reason) => {
    appendLog('[rejection]', [String(reason)]);
  });
};
