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

/**
 * Readable after the first unlock, so a background pull works while locked.
 * `v2`: the Keychain keeps an item's accessibility on update, and items
 * under the earlier `tokens.` key were WHEN_UNLOCKED.
 */
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

/** iOS Keychain-backed TokenStore. */
export const makeKeychainTokenStore = (storage: KeychainStorage): Layer.Layer<TokenStore> =>
  Layer.succeed(TokenStore, {
    get: (accountId) => Effect.promise(async () => decode(await storage.get(tokenKey(accountId)))),
    remove: (accountId) => Effect.promise(() => storage.delete(tokenKey(accountId))),
    set: (accountId, tokens) =>
      Effect.promise(() =>
        storage.set(tokenKey(accountId), JSON.stringify(Schema.encodeSync(TokenSet)(tokens))),
      ),
  });
