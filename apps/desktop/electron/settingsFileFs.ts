import {
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { SettingsFileFs } from './settingsFileSync.ts';

/**
 * The real file system behind the settings file sync. Kept free of
 * Electron imports so it is unit-tested against a temp directory: symlink
 * handling is exactly the kind of behaviour a fake disk cannot vouch for.
 */
export const nodeSettingsFileFs: SettingsFileFs = {
  mkdir: (dir) => {
    mkdirSync(dir, { recursive: true });
  },
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  realPath: (path) => {
    try {
      return realpathSync(path);
    } catch {
      // Missing, or a symlink whose target does not exist yet: name the
      // target so a first write creates it instead of replacing the link.
      try {
        return resolve(dirname(path), readlinkSync(path));
      } catch {
        return path;
      }
    }
  },
  stat: (path) => {
    try {
      const info = statSync(path);
      return { ino: info.ino, mtimeMs: info.mtimeMs, size: info.size };
    } catch {
      return null;
    }
  },
  watchDir: (dir, onChange) => {
    const watcher = watch(dir, { persistent: false }, (_event, filename) => {
      onChange(filename === null ? null : basename(String(filename)));
    });
    // A watched folder that is deleted reports an error; the periodic
    // check re-attaches once it exists again.
    watcher.on('error', () => {});
    return () => watcher.close();
  },
  writeTextAtomic: (path, text) => {
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, path);
  },
};
