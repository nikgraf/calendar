import { TokenSet } from '@calendar/core';
import { Effect, Fiber } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { type EncryptedStoreDeps, makeEncryptedTokenStore } from './encryptedStore.ts';

const tokens = (accessToken: string): TokenSet =>
  new TokenSet({
    accessToken,
    expiresAt: 1000,
    refreshToken: `refresh-${accessToken}`,
    scopes: ['openid'],
  });

const reverse = (text: string): string => [...text].reverse().join('');

/** A "keychain" that reverses strings, plus a file that records every write. */
const fakeDeps = (
  overrides: Partial<EncryptedStoreDeps> = {},
): EncryptedStoreDeps & { file: string | null; readonly writes: Array<string> } => {
  const state = { file: null as string | null, writes: [] as Array<string> };
  const base: EncryptedStoreDeps = {
    decrypt: async (blob) => ({ result: reverse(blob.toString('utf8')), shouldReEncrypt: false }),
    encrypt: async (text) => Buffer.from(reverse(text), 'utf8'),
    isEncryptionAvailable: async () => true,
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

/** A promise the test settles by hand, to hold an encryption or decryption mid-flight. */
const gate = () => {
  let resolve: (() => void) | undefined;
  const opened = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { open: () => resolve?.(), opened };
};

const run = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect);

/** The account's access token as a fresh process would read it from the file. */
const reread = (file: string | null, accountId: string) =>
  run(makeEncryptedTokenStore(fakeDeps({ readFile: () => file })).get(accountId)).then(
    (read) => read?.accessToken ?? null,
  );

describe('encrypted token store', () => {
  it('round-trips through the file and serves later reads from memory', async () => {
    const deps = fakeDeps();
    const store = makeEncryptedTokenStore(deps);
    await run(store.set('acc-1', tokens('a1')));
    expect(deps.writes).toHaveLength(1);
    expect(deps.file).not.toContain('a1'); // never plaintext on disk

    // A second store over the same file (a fresh process) decrypts it.
    const reopened = makeEncryptedTokenStore(fakeDeps({ readFile: () => deps.file }));
    expect((await run(reopened.get('acc-1')))?.accessToken).toBe('a1');
    expect(await run(reopened.get('missing'))).toBeNull();
  });

  it('keeps every account when two are written back to back', async () => {
    const deps = fakeDeps();
    const store = makeEncryptedTokenStore(deps);
    await run(store.set('acc-1', tokens('a1')));
    await run(store.set('acc-2', tokens('a2')));
    expect(await reread(deps.file, 'acc-1')).toBe('a1');
    expect(await reread(deps.file, 'acc-2')).toBe('a2');
    await run(store.remove('acc-1'));
    expect(await reread(deps.file, 'acc-1')).toBeNull();
    expect(await reread(deps.file, 'acc-2')).toBe('a2');
  });

  it('without encryption, tokens live in memory for the session and nothing is written', async () => {
    const deps = fakeDeps({ isEncryptionAvailable: async () => false });
    const store = makeEncryptedTokenStore(deps);
    await run(store.set('acc-1', tokens('a1')));
    expect((await run(store.get('acc-1')))?.accessToken).toBe('a1');
    expect(deps.writes).toHaveLength(0);
  });

  it('a failed encryption keeps the new tokens in memory and the file as it was', async () => {
    const deps = fakeDeps();
    await run(makeEncryptedTokenStore(deps).set('acc-1', tokens('a1')));
    const denied = fakeDeps({
      encrypt: () => Promise.reject(new Error('keychain denied')),
      readFile: () => deps.file,
    });
    const store = makeEncryptedTokenStore(denied);
    await run(store.set('acc-1', tokens('a2')));
    expect((await run(store.get('acc-1')))?.accessToken).toBe('a2');
    expect(denied.writes).toHaveLength(0);
    expect(await reread(deps.file, 'acc-1')).toBe('a1');
  });

  it('a blob that no longer decrypts reads as null and stays on disk', async () => {
    const deps = fakeDeps();
    await run(makeEncryptedTokenStore(deps).set('acc-1', tokens('a1')));
    const broken = makeEncryptedTokenStore(
      fakeDeps({
        decrypt: () => Promise.reject(new Error('keychain changed')),
        readFile: () => deps.file,
      }),
    );
    expect(await run(broken.get('acc-1'))).toBeNull();
    expect(deps.file).toContain('acc-1');
  });

  it('a blob the platform asks to re-encrypt is written again under the current key', async () => {
    const deps = fakeDeps();
    await run(makeEncryptedTokenStore(deps).set('acc-1', tokens('a1')));
    const before = deps.file;
    // The rotated "key" upper-cases; the old blobs still decrypt, flagged.
    const rotated = fakeDeps({
      decrypt: async (blob) => {
        const text = blob.toString('utf8');
        return text === text.toUpperCase()
          ? { result: reverse(text.toLowerCase()), shouldReEncrypt: false }
          : { result: reverse(text), shouldReEncrypt: true };
      },
      encrypt: async (text) => Buffer.from(reverse(text).toUpperCase(), 'utf8'),
      readFile: () => before,
    });
    const store = makeEncryptedTokenStore(rotated);
    expect((await run(store.get('acc-1')))?.accessToken).toBe('a1');
    expect(rotated.writes).toHaveLength(1);
    const blob = (JSON.parse(rotated.file ?? '{}') as Record<string, string>)['acc-1'];
    const text = Buffer.from(blob ?? '', 'base64').toString('utf8');
    expect(text).toBe(text.toUpperCase());
  });

  it('a removal right after a slow write leaves the account out of the file', async () => {
    const held = gate();
    const deps = fakeDeps({
      encrypt: async (text) => {
        await held.opened;
        return Buffer.from(reverse(text), 'utf8');
      },
    });
    const store = makeEncryptedTokenStore(deps);
    const writing = Effect.runFork(store.set('acc-1', tokens('a1')));
    const removing = Effect.runFork(store.remove('acc-1'));
    held.open();
    await run(Fiber.join(writing));
    await run(Fiber.join(removing));
    expect(await run(store.get('acc-1'))).toBeNull();
    expect(await reread(deps.file, 'acc-1')).toBeNull();
  });

  it('two writes of one account land in the order they were made', async () => {
    const first = gate();
    const deps = fakeDeps({
      encrypt: async (text) => {
        if (text.includes('"old"')) {
          await first.opened;
        }
        return Buffer.from(reverse(text), 'utf8');
      },
    });
    const store = makeEncryptedTokenStore(deps);
    const older = Effect.runFork(store.set('acc-1', tokens('old')));
    const newer = Effect.runFork(store.set('acc-1', tokens('new')));
    first.open();
    await run(Fiber.join(older));
    await run(Fiber.join(newer));
    expect((await run(store.get('acc-1')))?.accessToken).toBe('new');
    expect(await reread(deps.file, 'acc-1')).toBe('new');
  });

  it('a first read still decrypting does not cache tokens a write replaced meanwhile', async () => {
    const deps = fakeDeps();
    await run(makeEncryptedTokenStore(deps).set('acc-1', tokens('old')));
    const held = gate();
    const slow = fakeDeps({
      decrypt: async (blob) => {
        await held.opened;
        return { result: reverse(blob.toString('utf8')), shouldReEncrypt: false };
      },
      readFile: () => deps.file,
    });
    const store = makeEncryptedTokenStore(slow);
    const reading = Effect.runFork(store.get('acc-1'));
    const writing = Effect.runFork(store.set('acc-1', tokens('new')));
    held.open();
    expect((await run(Fiber.join(reading)))?.accessToken).toBe('old');
    await run(Fiber.join(writing));
    expect((await run(store.get('acc-1')))?.accessToken).toBe('new');
  });

  it('an unreadable file starts empty instead of throwing', async () => {
    const store = makeEncryptedTokenStore(fakeDeps({ readFile: () => '{oops' }));
    expect(await run(store.get('acc-1'))).toBeNull();
  });
});
