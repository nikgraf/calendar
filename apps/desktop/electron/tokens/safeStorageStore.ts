import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TokenSet } from '@calendar/core';
import { TokenStore } from '@calendar/google';
import { app, safeStorage } from 'electron';
import { Effect, Layer, Schema } from 'effect';

const storePath = (): string => join(app.getPath('userData'), 'secure', 'tokens.json');

type EncryptedBlobs = Record<string, string>;

const readBlobs = (): EncryptedBlobs => {
  try {
    return JSON.parse(readFileSync(storePath(), 'utf8')) as EncryptedBlobs;
  } catch {
    return {};
  }
};

const writeBlobs = (blobs: EncryptedBlobs): void => {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(blobs));
};

/**
 * TokenSets encrypted with the OS keychain-backed key (Electron safeStorage),
 * persisted as base64 blobs in userData. Never store tokens in plaintext.
 */
const store: typeof TokenStore.Service = {
  get: (accountId) =>
    Effect.sync(() => {
      const blob = readBlobs()[accountId];
      if (!blob) {
        return null;
      }
      try {
        const json = safeStorage.decryptString(Buffer.from(blob, 'base64'));
        return Schema.decodeUnknownSync(TokenSet)(JSON.parse(json));
      } catch {
        return null;
      }
    }),
  remove: (accountId) =>
    Effect.sync(() => {
      const blobs = readBlobs();
      delete blobs[accountId];
      writeBlobs(blobs);
    }),
  set: (accountId, tokens) =>
    Effect.sync(() => {
      const blobs = readBlobs();
      blobs[accountId] = safeStorage
        .encryptString(JSON.stringify(Schema.encodeSync(TokenSet)(tokens)))
        .toString('base64');
      writeBlobs(blobs);
    }),
};

export const safeStorageTokenStore: Layer.Layer<TokenStore> = Layer.sync(TokenStore, () => store);
