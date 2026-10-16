import { TokenSet } from '@calendar/core';
import { TokenStore } from '@calendar/google';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { type KeychainStorage, makeKeychainTokenStore } from './tokenStore.ts';

const tokens = (accessToken: string) =>
  new TokenSet({ accessToken, expiresAt: 1, refreshToken: 'refresh-1', scopes: ['calendar'] });
const raw = (set: TokenSet) => JSON.stringify(Schema.encodeSync(TokenSet)(set));

/** An in-memory Keychain whose writes can be made to fail. */
const fakeKeychain = (items: Record<string, string> = {}) => {
  const store = new Map(Object.entries(items));
  let failWrites = false;
  const storage: KeychainStorage = {
    delete: (key) => Promise.resolve(void store.delete(key)),
    get: (key) => Promise.resolve(store.get(key) ?? null),
    set: (key, value) =>
      failWrites
        ? Promise.reject(new Error('errSecInteractionNotAllowed'))
        : Promise.resolve(void store.set(key, value)),
  };
  return {
    failWrites: () => {
      failWrites = true;
    },
    storage,
    store,
  };
};

const run = <A>(
  storage: KeychainStorage,
  use: (store: TokenStore['Service']) => Effect.Effect<A>,
) =>
  Effect.runPromise(
    Effect.flatMap(TokenStore, use).pipe(Effect.provide(makeKeychainTokenStore(storage))),
  );

describe('makeKeychainTokenStore', () => {
  it('keeps the saved tokens when writing the replacement fails', async () => {
    const keychain = fakeKeychain({ 'tokens.v2.acc': raw(tokens('old')) });
    keychain.failWrites();
    await expect(
      run(keychain.storage, (store) => store.set('acc', tokens('new'))),
    ).rejects.toThrow();
    expect((await run(keychain.storage, (store) => store.get('acc')))?.accessToken).toBe('old');
  });

  it('reads back what it wrote', async () => {
    const keychain = fakeKeychain();
    await run(keychain.storage, (store) => store.set('acc', tokens('new')));
    expect([...keychain.store.keys()]).toEqual(['tokens.v2.acc']);
    expect((await run(keychain.storage, (store) => store.get('acc')))?.accessToken).toBe('new');
  });

  it('remove drops the tokens', async () => {
    const keychain = fakeKeychain({ 'tokens.v2.acc': raw(tokens('new')) });
    await run(keychain.storage, (store) => store.remove('acc'));
    expect(keychain.store.size).toBe(0);
    expect(await run(keychain.storage, (store) => store.get('acc'))).toBeNull();
  });
});
