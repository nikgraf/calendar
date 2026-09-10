import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TokenStore } from '@calendar/google';
import { app, safeStorage } from 'electron';
import { Layer } from 'effect';
import { makeEncryptedTokenStore } from './encryptedStore.ts';

const storePath = (): string => join(app.getPath('userData'), 'secure', 'tokens.json');

/**
 * Electron safeStorage-backed TokenStore. Never store tokens in plaintext.
 * The file is replaced atomically: written to a sibling temp file, then
 * renamed over — a crash or power loss mid-write used to truncate
 * tokens.json and sign every account out.
 */
export const safeStorageTokenStore: Layer.Layer<TokenStore> = Layer.sync(TokenStore, () =>
  makeEncryptedTokenStore({
    decrypt: (blob) => safeStorage.decryptString(blob),
    encrypt: (text) => safeStorage.encryptString(text),
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    readFile: () => {
      try {
        return readFileSync(storePath(), 'utf8');
      } catch {
        return null;
      }
    },
    writeFile: (text) => {
      const path = storePath();
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, text, { mode: 0o600 });
      renameSync(temp, path);
    },
  }),
);
