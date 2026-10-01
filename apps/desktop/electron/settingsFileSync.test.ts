import { formatSettingsDocument, type SettingsDocument } from '@calendar/core';
import { deviceSettingsKey } from '@calendar/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeSettingsFileSync,
  type SettingsFileApplied,
  type SettingsFileDeps,
  settingsFilePath,
  type SettingsFileSync,
  settingsTextHash,
} from './settingsFileSync.ts';

const PATH = '/home/nik/.solunivo/solunivo.jsonc';

describe('settingsFilePath', () => {
  it('keeps the packaged app and a dev build on different files', () => {
    expect(settingsFilePath({ env: {}, home: '/home/nik', packaged: true })).toBe(PATH);
    expect(settingsFilePath({ env: {}, home: '/home/nik', packaged: false })).toBe(
      '/home/nik/.solunivo/solunivo-dev.jsonc',
    );
  });

  it('lets CALENDAR_SETTINGS_FILE override both', () => {
    const env = { CALENDAR_SETTINGS_FILE: '/tmp/profile/solunivo.jsonc' };
    for (const packaged of [true, false]) {
      expect(settingsFilePath({ env, home: '/home/nik', packaged })).toBe(
        '/tmp/profile/solunivo.jsonc',
      );
    }
  });
});

const emptySummary = {
  appleAccountsPending: [],
  googleAccountsToAdd: [],
  notes: [],
  settingsChanged: [],
  visibilityChanges: 0,
  visibilityPending: 0,
};

const DIR = '/home/nik/.solunivo';

/** A fake disk, a backend whose state is one document, and the bookkeeping row. */
const makeWorld = (initial: { file?: string; state?: SettingsDocument } = {}) => {
  let nextIno = 100;
  const world = {
    applied: null as SettingsFileApplied | null,
    /** Folder → inode; a recreated folder gets a new one. */
    dirs: new Map<string, number>(initial.file === undefined ? [] : [[DIR, 1]]),
    file: initial.file ?? null,
    fileIno: 10,
    imports: [] as Array<SettingsDocument>,
    mtime: 1,
    /** Where the path resolves to; differs from PATH for a symlinked file. */
    real: PATH,
    state:
      initial.state ?? ({ version: 1, view: { allDayLaneCollapsed: false } } as SettingsDocument),
    watchers: [] as Array<{ dir: string; onChange: (file: string | null) => void }>,
    writePaths: [] as Array<string>,
    writes: [] as Array<string>,
  };
  const notify = (dir: string, file: string) => {
    for (const watcher of world.watchers) {
      if (watcher.dir === dir) {
        watcher.onChange(file);
      }
    }
  };
  const deps: SettingsFileDeps = {
    debounceMs: 10,
    exportDocument: () => Promise.resolve(world.state),
    fs: {
      mkdir: (dir) => {
        if (!world.dirs.has(dir)) {
          world.dirs.set(dir, (nextIno += 1));
        }
      },
      readText: () => world.file,
      realPath: () => world.real,
      stat: (path) => {
        if (path === PATH || path === world.real) {
          return world.file === null
            ? null
            : { ino: world.fileIno, mtimeMs: world.mtime, size: world.file.length };
        }
        const ino = world.dirs.get(path);
        return ino === undefined ? null : { ino, mtimeMs: 0, size: 0 };
      },
      watchDir: (dir, onChange) => {
        if (!world.dirs.has(dir)) {
          throw new Error(`ENOENT ${dir}`);
        }
        const watcher = { dir, onChange };
        world.watchers.push(watcher);
        return () => {
          world.watchers = world.watchers.filter((entry) => entry !== watcher);
        };
      },
      writeTextAtomic: (path, text) => {
        world.file = text;
        world.mtime += 1;
        world.writes.push(text);
        world.writePaths.push(path);
        notify(path.slice(0, path.lastIndexOf('/')), path.slice(path.lastIndexOf('/') + 1));
      },
    },
    importDocument: (document) => {
      world.imports.push(document);
      world.state = { ...world.state, ...document };
      return Promise.resolve(emptySummary);
    },
    now: () => 1000,
    pollMs: 1000,
    readLastApplied: () => Promise.resolve(world.applied),
    writeLastApplied: (applied) => {
      world.applied = applied;
      return Promise.resolve();
    },
  };
  /** An editor saving the file: content changes and the folder watcher fires. */
  const edit = (text: string) => {
    world.file = text;
    world.mtime += 1;
    notify(DIR, 'solunivo.jsonc');
  };
  /** A change no watcher reports (a synced volume, an edit at a symlink's target). */
  const silentEdit = (text: string) => {
    world.file = text;
    world.mtime += 1;
  };
  /** The folder is deleted: its watchers go silent, as a real watch does. */
  const removeDir = () => {
    world.dirs.delete(DIR);
    world.file = null;
    world.watchers = world.watchers.filter((entry) => entry.dir !== DIR);
  };
  /** The folder (re)appears with a file in it; nothing is watching yet. */
  const createDir = (text: string) => {
    world.dirs.set(DIR, (nextIno += 1));
    world.file = text;
    world.fileIno += 1;
    world.mtime += 1;
  };
  return { createDir, deps, edit, removeDir, silentEdit, world };
};

const settle = () => vi.advanceTimersByTimeAsync(50);
/** Long enough for one periodic check (pollMs is 1000 in the fake). */
const pollTick = () => vi.advanceTimersByTimeAsync(1100);

describe('makeSettingsFileSync', () => {
  let sync: SettingsFileSync | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    sync?.stop();
    sync = null;
    vi.useRealTimers();
  });

  it('applies an existing file on start when it is not what was last applied', async () => {
    const { deps, world } = makeWorld({
      file: '{ "version": 1, "view": { "allDayLaneCollapsed": true } }',
    });
    sync = makeSettingsFileSync(PATH, deps);
    await sync.start();
    expect(world.imports).toEqual([{ version: 1, view: { allDayLaneCollapsed: true } }]);
    expect(world.applied?.hash).toBeDefined();
    expect(sync.status()).toEqual({ exists: true, lastAppliedAt: 1000, path: PATH });
  });

  it('skips the start import when the file is what was last applied, but fills the file in', async () => {
    const text = '{ "version": 1 }';
    const { deps, world } = makeWorld({ file: text });
    world.applied = { appliedAt: 5, hash: settingsTextHash(text) };
    sync = makeSettingsFileSync(PATH, deps);
    await sync.start();
    expect(world.imports).toEqual([]);
    // The write-back merges the full state into the minimal file.
    expect(world.writes).toHaveLength(1);
    expect(world.file).toContain('"allDayLaneCollapsed": false');
    expect(world.file).toContain('"version": 1');
  });

  it('does nothing without a file, and never creates one on its own', async () => {
    const { deps, world } = makeWorld();
    sync = makeSettingsFileSync(PATH, deps);
    await sync.start();
    sync.onInvalidation([deviceSettingsKey('timeZones')]);
    await settle();
    expect(world.imports).toEqual([]);
    expect(world.writes).toEqual([]);
    expect(sync.status()).toEqual({ exists: false, path: PATH });
  });

  it('applies an external edit, and ignores the echo of its own write', async () => {
    const { deps, edit, world } = makeWorld({ file: '{ "version": 1 }' });
    sync = makeSettingsFileSync(PATH, deps);
    await sync.start();
    const importsAfterStart = world.imports.length;
    const writesAfterStart = world.writes.length;
    expect(writesAfterStart).toBe(1);
    // Our own write echoed through the watcher: no import of it.
    await settle();
    expect(world.imports).toHaveLength(importsAfterStart);

    edit('// hello\n{ "version": 1, "view": { "allDayLaneCollapsed": true } }\n');
    await settle();
    expect(world.imports.at(-1)).toEqual({ version: 1, view: { allDayLaneCollapsed: true } });
    expect(sync.status().error).toBeUndefined();
  });

  it('writes settings changes back into the file, keeping comments', async () => {
    const { deps, world } = makeWorld({
      file: '// keep me\n{ "version": 1, "view": { "allDayLaneCollapsed": false } }\n',
    });
    sync = makeSettingsFileSync(PATH, deps);
    await sync.start();
    world.state = { version: 1, view: { allDayLaneCollapsed: true } };
    sync.onInvalidation([deviceSettingsKey('viewPreferences')]);
    await settle();
    expect(world.file).toContain('// keep me');
    expect(world.file).toContain('"allDayLaneCollapsed": true');
    // A key the file does not track changes nothing.
    const writes = world.writes.length;
    sync.onInvalidation([deviceSettingsKey('settingsFile'), 'localNotifications.fired']);
    await settle();
    expect(world.writes).toHaveLength(writes);
  });

  it('a parse error is reported, not recorded, so the next good save applies', async () => {
    const { deps, edit, world } = makeWorld({ file: '{ "version": 1 }' });
    sync = makeSettingsFileSync(PATH, deps);
    await sync.start();
    const applied = world.applied;
    edit('{ "version": 1, ');
    await settle();
    expect(sync.status().error).toContain('line');
    expect(world.applied).toEqual(applied);
    edit('{ "version": 1, "view": { "allDayLaneCollapsed": true } }');
    await settle();
    expect(sync.status().error).toBeUndefined();
    expect(world.imports.at(-1)).toEqual({ version: 1, view: { allDayLaneCollapsed: true } });
  });

  it('an unapplied edit on disk wins over a pending write-back', async () => {
    const { deps, world } = makeWorld({ file: '{ "version": 1 }' });
    sync = makeSettingsFileSync(PATH, deps);
    await sync.start();
    // The file changed underneath us without a watcher event.
    world.file = '{ "version": 1, "view": { "allDayLaneCollapsed": true } }';
    world.state = { timeZones: { primary: 'UTC', zones: ['UTC'] }, version: 1 };
    sync.onInvalidation([deviceSettingsKey('timeZones')]);
    await settle();
    expect(world.imports.at(-1)).toEqual({ version: 1, view: { allDayLaneCollapsed: true } });
  });

  it('creates the file from the current state and starts watching its directory', async () => {
    const { deps, edit, world } = makeWorld();
    sync = makeSettingsFileSync(PATH, deps);
    await sync.start();
    expect(world.watchers).toHaveLength(0);
    await sync.createFromState();
    expect(world.file).toBe(formatSettingsDocument(world.state));
    expect(world.dirs.has(DIR)).toBe(true);
    expect(world.watchers).toHaveLength(1);
    expect(sync.status()).toEqual({ exists: true, lastAppliedAt: 1000, path: PATH });
    edit('{ "version": 1, "view": { "allDayLaneCollapsed": true } }');
    await settle();
    expect(world.imports).toHaveLength(1);
  });
});

describe('makeSettingsFileSync: review cases', () => {
  let sync: SettingsFileSync | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    sync?.stop();
    sync = null;
    vi.useRealTimers();
  });

  it('applies a restore of an older app-written text after an external edit', async () => {
    const { deps, edit, world } = makeWorld({ file: '{ "version": 1 }' });
    sync = makeSettingsFileSync(PATH, deps);
    await sync.start();
    const written = world.file!;
    // An editor changes the file (B), then puts the app's text (A) back.
    edit('{ "version": 1, "view": { "allDayLaneCollapsed": true } }');
    await settle();
    expect(world.imports.at(-1)).toEqual({ version: 1, view: { allDayLaneCollapsed: true } });
    edit(written);
    await settle();
    expect(world.imports.at(-1)).toEqual({ version: 1, view: { allDayLaneCollapsed: false } });
  });

  it('a save that lands while the export runs is applied, not overwritten', async () => {
    const { deps, world } = makeWorld({ file: '{ "version": 1 }' });
    let release: (() => void) | undefined;
    const slowDeps: SettingsFileDeps = {
      ...deps,
      exportDocument: () =>
        new Promise((resolve) => {
          release = () => resolve(world.state);
        }),
    };
    sync = makeSettingsFileSync(PATH, slowDeps);
    const started = sync.start();
    await settle();
    // start() is inside its write-back, waiting on the export. Save now.
    const saved = '{ "version": 1, "view": { "allDayLaneCollapsed": true } }';
    world.file = saved;
    world.mtime += 1;
    for (const watcher of world.watchers) {
      watcher.onChange('solunivo.jsonc');
    }
    release?.();
    await started;
    await settle();
    expect(world.imports.at(-1)).toEqual({ version: 1, view: { allDayLaneCollapsed: true } });
    expect(world.writes.some((text) => text === saved)).toBe(false);
    expect(world.file).toContain('"allDayLaneCollapsed": true');
  });
});

describe('makeSettingsFileSync: the periodic check and symlinks', () => {
  let sync: SettingsFileSync | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    sync?.stop();
    sync = null;
    vi.useRealTimers();
  });

  const collapsed = '{ "version": 1, "view": { "allDayLaneCollapsed": true } }';
  const expanded = '{ "version": 1, "view": { "allDayLaneCollapsed": false } }';

  it('applies a folder and file that appear after the app started, then watches them', async () => {
    const { createDir, deps, edit, world } = makeWorld();
    sync = makeSettingsFileSync(PATH, deps);
    await sync.start();
    expect(world.watchers).toHaveLength(0);

    createDir(collapsed);
    await pollTick();
    expect(world.imports).toEqual([{ version: 1, view: { allDayLaneCollapsed: true } }]);
    expect(sync.status().exists).toBe(true);
    expect(world.watchers).toHaveLength(1);

    // From here the watcher is the fast path again.
    edit(expanded);
    await settle();
    expect(world.imports.at(-1)).toEqual({ version: 1, view: { allDayLaneCollapsed: false } });
  });

  it('checkNow applies at once, without waiting for the next poll', async () => {
    const { createDir, deps, world } = makeWorld();
    sync = makeSettingsFileSync(PATH, deps);
    await sync.start();
    createDir(collapsed);
    await sync.checkNow();
    expect(world.imports).toHaveLength(1);
  });

  it('re-attaches when the folder is deleted and recreated', async () => {
    const { createDir, deps, edit, removeDir, world } = makeWorld({ file: '{ "version": 1 }' });
    sync = makeSettingsFileSync(PATH, deps);
    await sync.start();
    expect(world.watchers).toHaveLength(1);

    removeDir();
    await pollTick();
    expect(sync.status().exists).toBe(false);

    createDir(collapsed);
    await pollTick();
    expect(world.imports.at(-1)).toEqual({ version: 1, view: { allDayLaneCollapsed: true } });
    expect(world.watchers).toHaveLength(1);
    edit(expanded);
    await settle();
    expect(world.imports.at(-1)).toEqual({ version: 1, view: { allDayLaneCollapsed: false } });
  });

  it('reloads a change no watcher reported', async () => {
    const { deps, silentEdit, world } = makeWorld({ file: '{ "version": 1 }' });
    sync = makeSettingsFileSync(PATH, deps);
    await sync.start();
    // Let the echo of the start-up write-back pass first.
    await settle();
    const imports = world.imports.length;
    silentEdit(collapsed);
    await settle();
    expect(world.imports).toHaveLength(imports);
    await pollTick();
    expect(world.imports.at(-1)).toEqual({ version: 1, view: { allDayLaneCollapsed: true } });
  });

  it('stays quiet across checks when nothing changed or no file exists', async () => {
    const { deps, world } = makeWorld({ file: '{ "version": 1 }' });
    sync = makeSettingsFileSync(PATH, deps);
    await sync.start();
    const imports = world.imports.length;
    const writes = world.writes.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(world.imports).toHaveLength(imports);
    expect(world.writes).toHaveLength(writes);

    const empty = makeWorld();
    const other = makeSettingsFileSync(PATH, empty.deps);
    await other.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(empty.world.imports).toEqual([]);
    expect(empty.world.writes).toEqual([]);
    other.stop();
  });

  it('writes through a symlink to its target and watches both folders', async () => {
    const REAL = '/repo/dotfiles/solunivo.jsonc';
    const { deps, world } = makeWorld({ file: '// keep\n{ "version": 1 }\n' });
    world.real = REAL;
    world.dirs.set('/repo/dotfiles', 2);
    sync = makeSettingsFileSync(PATH, deps);
    await sync.start();
    // The start write-back filled the file in — at the target, not the link.
    expect(world.writePaths).toEqual([REAL]);
    expect(world.watchers.map((watcher) => watcher.dir).toSorted()).toEqual([
      DIR,
      '/repo/dotfiles',
    ]);

    world.state = { version: 1, view: { allDayLaneCollapsed: true } };
    sync.onInvalidation([deviceSettingsKey('viewPreferences')]);
    await settle();
    expect(world.writePaths).toEqual([REAL, REAL]);
    expect(world.file).toContain('// keep');

    // An in-place edit at the target fires in the target's folder.
    world.file = '{ "version": 1, "view": { "allDayLaneCollapsed": false } }';
    world.mtime += 1;
    for (const watcher of world.watchers) {
      if (watcher.dir === '/repo/dotfiles') {
        watcher.onChange('solunivo.jsonc');
      }
    }
    await settle();
    expect(world.imports.at(-1)).toEqual({ version: 1, view: { allDayLaneCollapsed: false } });
  });
});
