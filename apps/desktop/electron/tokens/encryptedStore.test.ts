import { TokenSet } from '@calendar/core';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { type EncryptedStoreDeps, makeEncryptedTokenStore } from './encryptedStore.ts';

const tokens = (accessToken: string): TokenSet =>
  new TokenSet({
    accessToken,
    expiresAt: 1000,
    refreshToken: `refresh-${accessToken}`,
    scopes: ['openid'],
  });

/** A "keychain" that reverses strings, plus a file that records every write. */
const fakeDeps = (
  overrides: Partial<EncryptedStoreDeps> = {},
): EncryptedStoreDeps & { file: string | null; readonly writes: Array<string> } => {
  const state = { file: null as string | null, writes: [] as Array<string> };
  const base: EncryptedStoreDeps = {
    decrypt: (blob) => [...blob.toString('utf8')].reverse().join(''),
    encrypt: (text) => Buffer.from([...text].reverse().join(''), 'utf8'),
    isEncryptionAvailable: () => true,
    readFile: () => state.file,
    writeFile: (text) => {
      state.file = text;
      state.writes.push(text);
    },
  };
  return {
    ...base,
    ...overrides,
    get file() {
      return state.file;
    },
    set file(value: string | null) {
      state.file = value;
    },
    get writes() {
      return state.writes;
    },
  };
};

const run = <A>(effect: Effect.Effect<A>): A => Effect.runSync(effect);

describe('encrypted token store', () => {
  it('round-trips through the file and serves later reads from memory', () => {
    const deps = fakeDeps();
    const store = makeEncryptedTokenStore(deps);
    run(store.set('acc-1', tokens('a1')));
    expect(deps.writes).toHaveLength(1);
    expect(deps.file).not.toContain('a1'); // never plaintext on disk

    // A second store over the same file (a fresh process) decrypts it.
    const reopened = makeEncryptedTokenStore(fakeDeps({ readFile: () => deps.file }));
    expect(run(reopened.get('acc-1'))?.accessToken).toBe('a1');
    expect(run(reopened.get('missing'))).toBeNull();
  });

  it('keeps every account when two are written back to back', () => {
    const deps = fakeDeps();
    const store = makeEncryptedTokenStore(deps);
    run(store.set('acc-1', tokens('a1')));
    run(store.set('acc-2', tokens('a2')));
    const reopened = makeEncryptedTokenStore(fakeDeps({ readFile: () => deps.file }));
    expect(run(reopened.get('acc-1'))?.accessToken).toBe('a1');
    expect(run(reopened.get('acc-2'))?.accessToken).toBe('a2');
    run(store.remove('acc-1'));
    const afterRemove = makeEncryptedTokenStore(fakeDeps({ readFile: () => deps.file }));
    expect(run(afterRemove.get('acc-1'))).toBeNull();
    expect(run(afterRemove.get('acc-2'))?.accessToken).toBe('a2');
  });

  it('without encryption, tokens live in memory for the session and nothing is written', () => {
    const deps = fakeDeps({ isEncryptionAvailable: () => false });
    const store = makeEncryptedTokenStore(deps);
    run(store.set('acc-1', tokens('a1')));
    expect(run(store.get('acc-1'))?.accessToken).toBe('a1');
    expect(deps.writes).toHaveLength(0);
  });

  it('a blob that no longer decrypts reads as null and stays on disk', () => {
    const deps = fakeDeps();
    run(makeEncryptedTokenStore(deps).set('acc-1', tokens('a1')));
    const broken = makeEncryptedTokenStore(
      fakeDeps({
        decrypt: () => {
          throw new Error('keychain changed');
        },
        readFile: () => deps.file,
      }),
    );
    expect(run(broken.get('acc-1'))).toBeNull();
    expect(deps.file).toContain('acc-1');
  });

  it('an unreadable file starts empty instead of throwing', () => {
    const store = makeEncryptedTokenStore(fakeDeps({ readFile: () => '{oops' }));
    expect(run(store.get('acc-1'))).toBeNull();
  });
});
