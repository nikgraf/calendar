import { formatSettingsDocument, type SettingsDocument } from '@calendar/core';
import { deviceSettingsKey } from '@calendar/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeSettingsFileSync,
  type SettingsFileApplied,
  type SettingsFileDeps,
  type SettingsFileSync,
  settingsTextHash,
} from './settingsFileSync.ts';

const PATH = '/home/nik/.solunivo/solunivo.jsonc';

const emptySummary = {
  appleAccountsPending: [],
  googleAccountsToAdd: [],
  notes: [],
  settingsChanged: [],
  visibilityChanges: 0,
  visibilityPending: 0,
};

/** A fake disk, a backend whose state is one document, and the bookkeeping row. */
const makeWorld = (initial: { file?: string; state?: SettingsDocument } = {}) => {
  const world = {
    applied: null as SettingsFileApplied | null,
    dirs: new Set<string>(initial.file === undefined ? [] : ['/home/nik/.solunivo']),
    file: initial.file ?? null,
    imports: [] as Array<SettingsDocument>,
    state:
      initial.state ?? ({ version: 1, view: { allDayLaneCollapsed: false } } as SettingsDocument),
    watchers: [] as Array<(file: string | null) => void>,
    writes: [] as Array<string>,
  };
  const deps: SettingsFileDeps = {
    debounceMs: 10,
    exportDocument: () => Promise.resolve(world.state),
    fs: {
      exists: () => world.file !== null,
      mkdir: (dir) => {
        world.dirs.add(dir);
      },
      readText: () => world.file,
      watchDir: (dir, onChange) => {
        if (!world.dirs.has(dir)) {
          throw new Error(`ENOENT ${dir}`);
        }
        world.watchers.push(onChange);
        return () => {
          world.watchers = world.watchers.filter((watcher) => watcher !== onChange);
        };
      },
      writeTextAtomic: (_path, text) => {
        world.file = text;
        world.writes.push(text);
        for (const watcher of world.watchers) {
          watcher('solunivo.jsonc');
        }
      },
    },
    importDocument: (document) => {
      world.imports.push(document);
      world.state = { ...world.state, ...document };
      return Promise.resolve(emptySummary);
    },
    now: () => 1000,
    readLastApplied: () => Promise.resolve(world.applied),
    writeLastApplied: (applied) => {
      world.applied = applied;
      return Promise.resolve();
    },
  };
  /** Simulates an editor saving the file. */
  const edit = (text: string) => {
    world.file = text;
    for (const watcher of world.watchers) {
      watcher('solunivo.jsonc');
    }
  };
  return { deps, edit, world };
};

const settle = () => vi.advanceTimersByTimeAsync(50);

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
    expect(world.dirs.has('/home/nik/.solunivo')).toBe(true);
    expect(world.watchers).toHaveLength(1);
    expect(sync.status()).toEqual({ exists: true, lastAppliedAt: 1000, path: PATH });
    edit('{ "version": 1, "view": { "allDayLaneCollapsed": true } }');
    await settle();
    expect(world.imports).toHaveLength(1);
  });
});
