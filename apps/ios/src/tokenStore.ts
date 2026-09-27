import { TokenSet } from '@calendar/core';
import { TokenStore } from '@calendar/google';
import { Effect, Layer, Schema } from 'effect';

/** The slice of expo-secure-store the token store uses; faked in tests. */
export interface KeychainStorage {
  readonly delete: (key: string) => Promise<void>;
  readonly get: (key: string) => Promise<string | null>;
  /** Writes readable after the first unlock since boot. */
  readonly set: (key: string, value: string) => Promise<void>;
}

/** Tokens before the background refresh: WHEN_UNLOCKED, read while migrating. */
const legacyKey = (accountId: string) => `tokens.${accountId}`;
/** Readable after the first unlock, so a background pull works while locked. */
const tokenKey = (accountId: string) => `tokens.v2.${accountId}`;

const decode = (raw: string | null): TokenSet | null => {
  if (!raw) {
    return null;
  }
  try {
    return Schema.decodeUnknownSync(TokenSet)(JSON.parse(raw));
  } catch {
    return null;
  }
};

/**
 * iOS Keychain-backed TokenStore. The Keychain keeps an existing item's
 * accessibility on update, so moving tokens to AFTER_FIRST_UNLOCK means
 * a new key. The old item is removed only once the new one is written:
 * the refresh token is the only copy, and losing it forces a sign-in.
 * A read that finds only the old item migrates it the same way (in the
 * foreground, where the old item is readable).
 */
export const makeKeychainTokenStore = (storage: KeychainStorage): Layer.Layer<TokenStore> => {
  /** Writes the new key, then drops the old one; a failed write keeps it. */
  const write = async (accountId: string, raw: string) => {
    await storage.set(tokenKey(accountId), raw);
    await storage.delete(legacyKey(accountId)).catch(() => {
      // A leftover old item is never read while the new one exists.
    });
  };
  return Layer.succeed(TokenStore, {
    get: (accountId) =>
      Effect.promise(async () => {
        const current = decode(await storage.get(tokenKey(accountId)));
        if (current) {
          return current;
        }
        const raw = await storage.get(legacyKey(accountId));
        const legacy = decode(raw);
        if (legacy && raw) {
          await write(accountId, raw).catch(() => {
            // Still readable from the old item; the next write migrates it.
          });
        }
        return legacy;
      }),
    remove: (accountId) =>
      Effect.promise(async () => {
        await storage.delete(tokenKey(accountId));
        await storage.delete(legacyKey(accountId));
      }),
    set: (accountId, tokens) =>
      Effect.promise(() => write(accountId, JSON.stringify(Schema.encodeSync(TokenSet)(tokens)))),
  });
};
