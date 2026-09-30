import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import {
  formatSettingsDocument,
  mergeSettingsDocument,
  parseSettingsDocument,
  type SettingsDocument,
  type SettingsImportSummary,
} from '@calendar/core';
import { ACCOUNTS_KEY, CALENDARS_KEY, deviceSettingsKey, TASKLISTS_KEY } from '@calendar/db';
import { Effect } from 'effect';

/**
 * Two-way sync between the backend and the watched settings file
 * (`~/.solunivo/solunivo.jsonc`). File → app: on start and whenever the
 * file changes on disk, parse and import. App → file: whenever a setting,
 * account or visibility changes, export and merge into the file's text
 * (comments survive). The hash of the last text this module applied — or
 * wrote, which counts as applied — tells the two directions apart: the
 * watcher ignores our own writes, the write-back yields to an edit it has
 * not applied yet, and an external edit supersedes the marker so a later
 * restore of an older text is applied again, not mistaken for an echo.
 * Pure orchestration: every side effect comes in through `deps`, so the
 * loop guard is unit-tested without Electron or a real file system.
 */

/** The bookkeeping row in device_settings: what the file held when it was last applied. */
export const SETTINGS_FILE_KEY = 'settingsFile';

export interface SettingsFileApplied {
  readonly appliedAt: number;
  readonly hash: string;
}

export interface SettingsFileFs {
  readonly exists: (path: string) => boolean;
  readonly mkdir: (dir: string) => void;
  readonly readText: (path: string) => string | null;
  /**
   * Watches a directory (not the file: editors save by rename, which
   * would orphan a file watch) and reports the changed name, or null when
   * the platform does not say. Returns the unsubscribe; may throw when
   * the directory does not exist yet.
   */
  readonly watchDir: (dir: string, onChange: (file: string | null) => void) => () => void;
  /** Temp file + rename: a crash mid-write must not leave a truncated file. */
  readonly writeTextAtomic: (path: string, text: string) => void;
}

export interface SettingsFileDeps {
  readonly debounceMs?: number;
  readonly exportDocument: () => Promise<SettingsDocument>;
  readonly fs: SettingsFileFs;
  readonly importDocument: (document: SettingsDocument) => Promise<SettingsImportSummary>;
  readonly log?: (message: string, meta?: Record<string, unknown>) => void;
  readonly now?: () => number;
  readonly readLastApplied: () => Promise<SettingsFileApplied | null>;
  readonly writeLastApplied: (applied: SettingsFileApplied) => Promise<void>;
}

export interface SettingsFileStatus {
  /** The last parse or import failure; cleared by the next successful apply. */
  readonly error?: string;
  readonly exists: boolean;
  readonly lastAppliedAt?: number;
  readonly path: string;
}

/** The invalidation keys after which the file is brought up to date. */
export const SETTINGS_FILE_TRIGGER_KEYS: ReadonlySet<string> = new Set([
  ACCOUNTS_KEY,
  CALENDARS_KEY,
  TASKLISTS_KEY,
  deviceSettingsKey('birthdayReminders'),
  deviceSettingsKey('eventNotifications'),
  deviceSettingsKey('importedVisibility'),
  deviceSettingsKey('timeZones'),
  deviceSettingsKey('viewPreferences'),
]);

export const settingsTextHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

export interface SettingsFileSync {
  /** Parses and imports the file when its content is not what was last applied or written. */
  readonly applyFromDisk: () => Promise<void>;
  /** Writes a fresh document from the current state and starts watching it. */
  readonly createFromState: () => Promise<void>;
  readonly onInvalidation: (keys: ReadonlyArray<string>) => void;
  /** A host-held setting (screen privacy) changed. */
  readonly onPlatformChange: () => void;
  readonly start: () => Promise<void>;
  readonly status: () => SettingsFileStatus;
  readonly stop: () => void;
  readonly subscribeStatus: (listener: (status: SettingsFileStatus) => void) => () => void;
  /** Merges the current state into the file; a no-op without a file or when nothing differs. */
  readonly writeBack: () => Promise<void>;
}

export const makeSettingsFileSync = (path: string, deps: SettingsFileDeps): SettingsFileSync => {
  const debounceMs = deps.debounceMs ?? 300;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const dir = dirname(path);
  const name = basename(path);

  let lastApplied: string | null = null;
  let started = false;
  let stopped = false;
  let unwatch: (() => void) | null = null;
  let applyTimer: NodeJS.Timeout | null = null;
  let writeTimer: NodeJS.Timeout | null = null;
  // Every disk/backend operation runs on this chain so an apply and a
  // write-back never interleave.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = chain.then(task, task);
    chain = next.catch(() => {});
    return next;
  };

  let status: SettingsFileStatus = { exists: false, path };
  const listeners = new Set<(status: SettingsFileStatus) => void>();
  const setStatus = (next: SettingsFileStatus) => {
    status = next;
    for (const listener of listeners) {
      listener(status);
    }
  };
  /** Replaces exists/error; keeps the last applied time unless a new one is given. */
  const update = (patch: { exists: boolean; lastAppliedAt?: number }, error?: string) => {
    const lastAppliedAt = patch.lastAppliedAt ?? status.lastAppliedAt;
    setStatus({
      ...(error === undefined ? {} : { error }),
      exists: patch.exists,
      ...(lastAppliedAt === undefined ? {} : { lastAppliedAt }),
      path,
    });
  };

  const recordApplied = async (hash: string) => {
    lastApplied = hash;
    const appliedAt = now();
    await deps.writeLastApplied({ appliedAt, hash });
    update({ exists: true, lastAppliedAt: appliedAt });
  };

  const applyText = async (text: string) => {
    const hash = settingsTextHash(text);
    const parsed = await Effect.runPromise(
      parseSettingsDocument(text).pipe(
        Effect.match({
          onFailure: (error): { readonly error: string } => ({ error: error.message }),
          onSuccess: (document): { readonly document: SettingsDocument } => ({ document }),
        }),
      ),
    );
    if ('error' in parsed) {
      log('settings file not applied', { error: parsed.error });
      // The hash is not recorded: the next good save still applies.
      update({ exists: true }, parsed.error);
      return;
    }
    try {
      const summary = await deps.importDocument(parsed.document);
      log('settings file applied', { ...summary });
      await recordApplied(hash);
    } catch (error) {
      log('settings file import failed', { error: String(error) });
      update({ exists: true }, String(error));
    }
  };

  const applyFromDisk = () =>
    enqueue(async () => {
      if (stopped) {
        return;
      }
      const text = deps.fs.readText(path);
      if (text === null) {
        update({ exists: false });
        return;
      }
      const hash = settingsTextHash(text);
      if (hash === lastApplied) {
        update({ exists: true });
        return;
      }
      await applyText(text);
    });

  const writeBack = () =>
    enqueue(async () => {
      if (stopped) {
        return;
      }
      const text = deps.fs.readText(path);
      if (text === null) {
        update({ exists: false });
        return;
      }
      if (settingsTextHash(text) !== lastApplied) {
        // An edit on disk we have not applied wins over what we would
        // write; its import re-triggers the write-back.
        await applyText(text);
        return;
      }
      const document = await deps.exportDocument();
      // A save that landed while the export ran must not be overwritten:
      // the watcher's callback is still queued behind this task and would
      // only see our replacement. Take the edit instead; its import
      // re-triggers the write-back.
      const latest = deps.fs.readText(path);
      if (latest === null) {
        update({ exists: false });
        return;
      }
      if (latest !== text) {
        await applyText(latest);
        return;
      }
      const merged = mergeSettingsDocument(text, document);
      if (merged === text) {
        return;
      }
      const mergedHash = settingsTextHash(merged);
      // Set before the rename so the watcher's event finds it known.
      lastApplied = mergedHash;
      deps.fs.writeTextAtomic(path, merged);
      const appliedAt = now();
      await deps.writeLastApplied({ appliedAt, hash: mergedHash });
      update({ exists: true, lastAppliedAt: appliedAt });
    });

  const arm = () => {
    if (unwatch || stopped) {
      return;
    }
    try {
      unwatch = deps.fs.watchDir(dir, (file) => {
        if (file !== null && file !== name) {
          return;
        }
        if (applyTimer) {
          clearTimeout(applyTimer);
        }
        applyTimer = setTimeout(() => {
          applyTimer = null;
          void applyFromDisk();
        }, debounceMs);
      });
    } catch (error) {
      // No directory yet: `createFromState` arms after making it.
      log('settings file directory not watched', { error: String(error) });
    }
  };

  const scheduleWriteBack = () => {
    if (!started || stopped) {
      return;
    }
    if (writeTimer) {
      clearTimeout(writeTimer);
    }
    writeTimer = setTimeout(() => {
      writeTimer = null;
      void writeBack();
    }, debounceMs);
  };

  return {
    applyFromDisk,
    createFromState: () =>
      enqueue(async () => {
        if (stopped) {
          return;
        }
        const text = formatSettingsDocument(await deps.exportDocument());
        const existing = deps.fs.readText(path);
        if (existing !== null) {
          // Appeared while the export ran (another app instance, a sync
          // client): apply it rather than replace it.
          await applyText(existing);
          arm();
          return;
        }
        const hash = settingsTextHash(text);
        lastApplied = hash;
        deps.fs.mkdir(dir);
        deps.fs.writeTextAtomic(path, text);
        const appliedAt = now();
        await deps.writeLastApplied({ appliedAt, hash });
        update({ exists: true, lastAppliedAt: appliedAt });
        arm();
      }),
    onInvalidation: (keys) => {
      if (keys.some((key) => SETTINGS_FILE_TRIGGER_KEYS.has(key))) {
        scheduleWriteBack();
      }
    },
    onPlatformChange: scheduleWriteBack,
    start: async () => {
      const applied = await deps.readLastApplied();
      lastApplied = applied?.hash ?? null;
      if (applied) {
        update({ exists: status.exists, lastAppliedAt: applied.appliedAt });
      }
      await applyFromDisk();
      // Only now: exporting before the initial import would write the
      // pre-import state over the file.
      started = true;
      arm();
      await writeBack();
    },
    status: () => status,
    stop: () => {
      stopped = true;
      if (applyTimer) {
        clearTimeout(applyTimer);
      }
      if (writeTimer) {
        clearTimeout(writeTimer);
      }
      unwatch?.();
      unwatch = null;
    },
    subscribeStatus: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    writeBack,
  };
};
