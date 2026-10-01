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
 *
 * Directory watchers are only the fast path. The source of truth is a
 * periodic check (`checkNow`, also run on window focus): one stat of the
 * file, a reload when its identity or modification time moved, and a
 * re-attach of the watchers when the folders they should watch changed.
 * That covers what a watcher alone cannot: the folder appearing after the
 * app started, a folder deleted and recreated (the old watch goes silent),
 * events dropped on network or synced volumes, and a symlinked file edited
 * at its target.
 *
 * Pure orchestration: every side effect comes in through `deps`, so the
 * loop guard is unit-tested without Electron or a real file system.
 */

/** The bookkeeping row in device_settings: what the file held when it was last applied. */
export const SETTINGS_FILE_KEY = 'settingsFile';

export interface SettingsFileApplied {
  readonly appliedAt: number;
  readonly hash: string;
}

/** What identifies one version of a file or directory on disk. */
export interface SettingsFileStat {
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
}

export interface SettingsFileFs {
  readonly mkdir: (dir: string) => void;
  readonly readText: (path: string) => string | null;
  /**
   * Where the path really lives: symlinks resolved, a dangling link's
   * target, or the path itself when there is nothing to resolve. Writes
   * go here — renaming over a symlink would replace the link with a
   * regular file and silently detach a dotfiles repo.
   */
  readonly realPath: (path: string) => string;
  /** Follows symlinks; null when the path does not exist. */
  readonly stat: (path: string) => SettingsFileStat | null;
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
  /** How often the file is re-checked without a watcher event. */
  readonly pollMs?: number;
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
  /** One reconciliation pass: re-attach watchers if needed, reload if the file moved on. */
  readonly checkNow: () => Promise<void>;
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
  const pollMs = deps.pollMs ?? 5000;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const dir = dirname(path);
  const name = basename(path);

  let lastApplied: string | null = null;
  let started = false;
  let stopped = false;
  let unwatchers: Array<() => void> = [];
  /** The watch targets (folder, name, folder identity) the watchers were attached for. */
  let armedKey: string | null = null;
  /** The file's identity and modification time at the last check. */
  let lastSeen: string | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
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
      deps.fs.writeTextAtomic(deps.fs.realPath(path), merged);
      const appliedAt = now();
      await deps.writeLastApplied({ appliedAt, hash: mergedHash });
      update({ exists: true, lastAppliedAt: appliedAt });
    });

  const onWatchEvent = (expected: string) => (file: string | null) => {
    if (file !== null && file !== expected) {
      return;
    }
    if (applyTimer) {
      clearTimeout(applyTimer);
    }
    applyTimer = setTimeout(() => {
      applyTimer = null;
      void applyFromDisk();
    }, debounceMs);
  };

  /**
   * The folders worth watching: the one the path names (the file being
   * created, replaced or saved by rename) and, for a symlinked file, the
   * one its target lives in (an edit made in place at the target fires
   * there, not at the link).
   */
  const watchTargets = (): ReadonlyArray<{ readonly dir: string; readonly name: string }> => {
    const real = deps.fs.realPath(path);
    const realDir = dirname(real);
    const realName = basename(real);
    return realDir === dir && realName === name
      ? [{ dir, name }]
      : [
          { dir, name },
          { dir: realDir, name: realName },
        ];
  };

  /** Attaches the watchers, again whenever a target folder appeared, vanished or was replaced. */
  const ensureWatchers = () => {
    if (stopped) {
      return;
    }
    const targets = watchTargets();
    const key = targets
      .map(
        (target) => `${target.dir}\n${target.name}\n${deps.fs.stat(target.dir)?.ino ?? 'missing'}`,
      )
      .join('\n\n');
    if (key === armedKey) {
      return;
    }
    for (const unwatch of unwatchers) {
      unwatch();
    }
    unwatchers = [];
    armedKey = key;
    for (const target of targets) {
      try {
        unwatchers.push(deps.fs.watchDir(target.dir, onWatchEvent(target.name)));
      } catch (error) {
        // No such folder (yet): the next check attaches once it exists.
        log('settings file directory not watched', { dir: target.dir, error: String(error) });
      }
    }
  };

  const checkNow = async (): Promise<void> => {
    if (!started || stopped) {
      return;
    }
    ensureWatchers();
    const info = deps.fs.stat(path);
    const seen = info === null ? null : `${info.ino}:${info.mtimeMs}:${info.size}`;
    if (seen === lastSeen) {
      return;
    }
    lastSeen = seen;
    // Hash-guarded: our own writes and unchanged content are no-ops.
    await applyFromDisk();
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
    checkNow,
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
          ensureWatchers();
          return;
        }
        const hash = settingsTextHash(text);
        lastApplied = hash;
        deps.fs.mkdir(dir);
        // A dangling symlink at the path: create its target, keep the link.
        const target = deps.fs.realPath(path);
        deps.fs.mkdir(dirname(target));
        deps.fs.writeTextAtomic(target, text);
        const appliedAt = now();
        await deps.writeLastApplied({ appliedAt, hash });
        update({ exists: true, lastAppliedAt: appliedAt });
        ensureWatchers();
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
      ensureWatchers();
      await writeBack();
      const info = deps.fs.stat(path);
      lastSeen = info === null ? null : `${info.ino}:${info.mtimeMs}:${info.size}`;
      pollTimer = setInterval(() => void checkNow(), pollMs);
      pollTimer.unref?.();
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
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      for (const unwatch of unwatchers) {
        unwatch();
      }
      unwatchers = [];
    },
    subscribeStatus: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    writeBack,
  };
};
