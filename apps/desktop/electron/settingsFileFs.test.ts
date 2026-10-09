import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SettingsDocument } from '@calendar/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { nodeSettingsFileFs as fs } from './settingsFileFs.ts';
import {
  makeSettingsFileSync,
  type SettingsFileApplied,
  type SettingsFileSync,
} from './settingsFileSync.ts';

const emptySummary = {
  appleAccountsPending: [],
  googleAccountsToAdd: [],
  notes: [],
  settingsChanged: [],
  visibilityChanges: 0,
  visibilityPending: 0,
};

/** The real file system, in a temp directory: what a fake disk cannot vouch for. */
describe('nodeSettingsFileFs', () => {
  let root: string;

  beforeEach(() => {
    // realpath: macOS temp dirs sit behind /var → /private/var.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'solunivo-fs-')));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  /** home/.solunivo/solunivo.jsonc → repo/solunivo.jsonc, as a dotfiles manager links it. */
  const linkedSetup = (content: string | null) => {
    const target = join(root, 'repo', 'solunivo.jsonc');
    const link = join(root, 'home', '.solunivo', 'solunivo.jsonc');
    mkdirSync(join(root, 'repo'));
    mkdirSync(join(root, 'home', '.solunivo'), { recursive: true });
    if (content !== null) {
      writeFileSync(target, content);
    }
    symlinkSync(target, link);
    return { link, target };
  };

  it('resolves a symlink, and an atomic write to the real path keeps the link', () => {
    const { link, target } = linkedSetup('old');
    expect(fs.realPath(link)).toBe(target);
    fs.writeTextAtomic(fs.realPath(link), 'new');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(fs.readText(link)).toBe('new');
  });

  it('writing to the link itself would replace it — the reason writes resolve first', () => {
    const { link, target } = linkedSetup('old');
    fs.writeTextAtomic(link, 'new');
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('old');
  });

  it('names the target of a dangling symlink, and the path itself when nothing is there', () => {
    const { link, target } = linkedSetup(null);
    expect(fs.readText(link)).toBeNull();
    expect(fs.realPath(link)).toBe(target);
    const missing = join(root, 'nowhere', 'solunivo.jsonc');
    expect(fs.realPath(missing)).toBe(missing);
  });

  it('stat follows the link and is null for a missing path', () => {
    const { link, target } = linkedSetup('one');
    const before = fs.stat(link);
    expect(before?.size).toBe(3);
    writeFileSync(target, 'three');
    expect(fs.stat(link)?.size).toBe(5);
    expect(fs.stat(join(root, 'missing'))).toBeNull();
  });
});

describe('settings file sync on the real file system', () => {
  let root: string;
  let sync: SettingsFileSync | null = null;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'solunivo-sync-')));
  });

  afterEach(() => {
    sync?.stop();
    sync = null;
    rmSync(root, { force: true, recursive: true });
  });

  const backend = () => {
    const state = {
      applied: null as SettingsFileApplied | null,
      document: { version: 1, view: { allDayLaneCollapsed: false } } as SettingsDocument,
      imports: [] as Array<SettingsDocument>,
    };
    const start = (path: string) => {
      sync = makeSettingsFileSync(path, {
        debounceMs: 5,
        exportDocument: () => Promise.resolve(state.document),
        fs,
        importDocument: (document) => {
          state.imports.push(document);
          state.document = { ...state.document, ...document };
          return Promise.resolve(emptySummary);
        },
        pollMs: 25,
        readLastApplied: () => Promise.resolve(state.applied),
        writeLastApplied: (applied) => {
          state.applied = applied;
          return Promise.resolve();
        },
      });
      return sync;
    };
    return { start, state };
  };

  it('applies a folder and file created after the start', async () => {
    const { start, state } = backend();
    const path = join(root, '.solunivo', 'solunivo.jsonc');
    const running = start(path);
    await running.start();
    expect(running.status().exists).toBe(false);

    mkdirSync(join(root, '.solunivo'));
    writeFileSync(path, '// mine\n{ "version": 1, "view": { "allDayLaneCollapsed": true } }\n');
    await vi.waitFor(() => expect(state.imports).toHaveLength(1), { timeout: 5000 });
    expect(state.imports[0]).toEqual({ version: 1, view: { allDayLaneCollapsed: true } });
    expect(running.status().exists).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('// mine');
  });

  it('keeps a symlinked file a symlink across write-backs and reloads edits at the target', async () => {
    const { start, state } = backend();
    const target = join(root, 'repo', 'solunivo.jsonc');
    const link = join(root, 'home', '.solunivo', 'solunivo.jsonc');
    mkdirSync(join(root, 'repo'));
    mkdirSync(join(root, 'home', '.solunivo'), { recursive: true });
    writeFileSync(target, '// repo copy\n{ "version": 1 }\n');
    symlinkSync(target, link);

    const running = start(link);
    await running.start();
    // The start write-back filled the file in through the link.
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('"allDayLaneCollapsed": false');
    expect(readFileSync(target, 'utf8')).toContain('// repo copy');

    // Edit in the repo, in place: no event in the link's folder.
    writeFileSync(target, '{ "version": 1, "view": { "allDayLaneCollapsed": true } }\n');
    await vi.waitFor(
      () =>
        expect(state.imports.at(-1)).toEqual({ version: 1, view: { allDayLaneCollapsed: true } }),
      { timeout: 5000 },
    );
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});
