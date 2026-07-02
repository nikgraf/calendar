import { TokenSet } from '@calendar/core/types';
import { Context, Effect, Layer } from 'effect';

/**
 * Secure per-account token persistence. Implemented per platform:
 * expo-secure-store (iOS Keychain) and Electron safeStorage.
 */
export class TokenStore extends Context.Service<
  TokenStore,
  {
    readonly get: (accountId: string) => Effect.Effect<TokenSet | null>;
    readonly remove: (accountId: string) => Effect.Effect<void>;
    readonly set: (accountId: string, tokens: TokenSet) => Effect.Effect<void>;
  }
>()('google/TokenStore') {
  /** In-memory implementation for tests. */
  static readonly layerMemory: Layer.Layer<TokenStore> = Layer.sync(TokenStore, () => {
    const tokens = new Map<string, TokenSet>();
    return {
      get: (accountId) => Effect.sync(() => tokens.get(accountId) ?? null),
      remove: (accountId) =>
        Effect.sync(() => {
          tokens.delete(accountId);
        }),
      set: (accountId, tokenSet) =>
        Effect.sync(() => {
          tokens.set(accountId, tokenSet);
        }),
    };
  });
}
