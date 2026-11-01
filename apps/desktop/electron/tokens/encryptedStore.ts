import { TokenSet } from '@calendar/core';
import type { TokenStore } from '@calendar/google';
import { Effect, Schema } from 'effect';

/** The platform pieces the store needs — Electron's in production, fakes in tests. */
export interface EncryptedStoreDeps {
  /**
   * Rejects when the blob does not decrypt. `shouldReEncrypt` says the blob
   * was written with a key the platform no longer encrypts with.
   */
  readonly decrypt: (
    blob: Buffer,
  ) => Promise<{ readonly result: string; readonly shouldReEncrypt: boolean }>;
  /** Rejects when there is no key to encrypt with (e.g. a denied keychain prompt). */
  readonly encrypt: (text: string) => Promise<Buffer>;
  /** False when nothing can be encrypted at all (e.g. before the app is ready). */
  readonly isEncryptionAvailable: () => Promise<boolean>;
  /** The persisted blob file, or null when there is none yet. */
  readonly readFile: () => string | null;
  /** Must replace the file atomically (temp file + rename): a crash mid-write must not truncate it. */
  readonly writeFile: (text: string) => void;
}

type EncryptedBlobs = Record<string, string>;

/** A dep's promise as an Effect that fails with the rejection itself, for the log. */
const attempt = <A>(run: () => Promise<A>) =>
  Effect.result(Effect.tryPromise({ catch: (error) => error, try: run }));

const logWriteFailure = (error: unknown) =>
  error === undefined
    ? Effect.void
    : Effect.logError('token store write failed', { error: String(error) });

/**
 * TokenSets encrypted with the OS keychain-backed key, persisted as base64
 * blobs in one JSON file. Decisions:
 * - The blob map is read once and kept in memory: `get` used to re-read
 *   and re-parse the file plus a keychain round trip on every authed
 *   request, and `set` was a read-modify-write over the whole map while
 *   TokenManager's refresh lock is per account — two refreshes could lose
 *   a write. Decrypted TokenSets are cached per account.
 * - Memory changes the moment `set` or `remove` is called; the file
 *   follows. Encryption waits on the keychain, so each call bumps the
 *   account's change number, and an encrypted blob lands only if no later
 *   write or removal of that account was made while it waited — the last
 *   call wins in whatever order the keychain answers. A first read caches
 *   what it decrypted under the same rule, so a read after a write never
 *   sees what it replaced (TokenManager's invalidate reads, then writes
 *   back what it read).
 * - Every change to memory, the blob map and the file is one synchronous
 *   step after any wait, so an interruption (a cancelled rpc) never leaves
 *   one half done. A `set` interrupted while encrypting keeps its tokens
 *   in memory only, as a failed encryption does.
 * - Writes go through `writeFile`, which must be atomic (temp + rename).
 * - No encryption available: tokens live in memory for this session only
 *   and are never written — sign-in works, nothing persists, and the log
 *   says so once. A failed encryption keeps them in memory too, logged;
 *   it used to be a defect from a `never`-error `set`, killing the sync
 *   pass. A removal writes no secret, so it reaches the file regardless.
 * - A blob that no longer decrypts is logged at error level (the user
 *   appears signed out and should know why); the blob is left in place.
 *   One the platform asks to re-encrypt (written with a key it no longer
 *   encrypts with; never on macOS today) is written again with the
 *   current one, so dropping the old key later strands no account.
 */
export const makeEncryptedTokenStore = (deps: EncryptedStoreDeps): typeof TokenStore.Service => {
  let blobs: EncryptedBlobs | null = null;
  const cache = new Map<string, TokenSet>();
  /** Per account, how many writes and removals have been made; unchanged across a wait means none came in between. */
  const changes = new Map<string, number>();
  let warnedUnavailable = false;

  const loadBlobs = (): EncryptedBlobs => {
    if (blobs === null) {
      try {
        const text = deps.readFile();
        const parsed: unknown = text === null ? {} : JSON.parse(text);
        blobs =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as EncryptedBlobs)
            : {};
      } catch {
        blobs = {};
      }
    }
    return blobs;
  };

  const changeOf = (accountId: string): number => changes.get(accountId) ?? 0;

  const change = (accountId: string): number => {
    const next = changeOf(accountId) + 1;
    changes.set(accountId, next);
    return next;
  };

  /** Writes the blob map; what it threw, if anything, for the log. */
  const writeBlobs = (): unknown => {
    try {
      deps.writeFile(JSON.stringify(loadBlobs()));
      return undefined;
    } catch (error) {
      return error;
    }
  };

  /** Encrypts an account's tokens into the file, unless the account changed again meanwhile. */
  const persist = (accountId: string, tokens: TokenSet, asOf: number) =>
    Effect.gen(function* () {
      if (!(yield* Effect.promise(() => deps.isEncryptionAvailable().catch(() => false)))) {
        if (!warnedUnavailable) {
          warnedUnavailable = true;
          yield* Effect.logError(
            'safeStorage encryption unavailable: tokens are kept in memory for this session only',
          );
        }
        return;
      }
      const encrypted = yield* attempt(() =>
        deps.encrypt(JSON.stringify(Schema.encodeSync(TokenSet)(tokens))),
      );
      if (encrypted._tag === 'Failure') {
        yield* Effect.logError('token encryption failed; kept in memory only', {
          accountId,
          error: String(encrypted.failure),
        });
        return;
      }
      const blob = encrypted.success.toString('base64');
      const failure = yield* Effect.sync(() => {
        if (changeOf(accountId) !== asOf) {
          return undefined;
        }
        loadBlobs()[accountId] = blob;
        return writeBlobs();
      });
      yield* logWriteFailure(failure);
    });

  return {
    get: (accountId) =>
      Effect.suspend(() => {
        const cached = cache.get(accountId);
        if (cached) {
          return Effect.succeed(cached);
        }
        const blob = loadBlobs()[accountId];
        if (!blob) {
          return Effect.succeed(null);
        }
        const asOf = changeOf(accountId);
        return Effect.gen(function* () {
          const decrypted = yield* attempt(async () => {
            const { result, shouldReEncrypt } = await deps.decrypt(Buffer.from(blob, 'base64'));
            return {
              shouldReEncrypt,
              tokens: Schema.decodeUnknownSync(TokenSet)(JSON.parse(result)),
            };
          });
          // A write or removal made while this decrypted is newer than the blob.
          if (changeOf(accountId) !== asOf) {
            return cache.get(accountId) ?? null;
          }
          if (decrypted._tag === 'Failure') {
            yield* Effect.logError('stored tokens could not be decrypted', {
              accountId,
              error: String(decrypted.failure),
            });
            return null;
          }
          const { shouldReEncrypt, tokens } = decrypted.success;
          cache.set(accountId, tokens);
          if (shouldReEncrypt) {
            yield* persist(accountId, tokens, asOf);
          }
          return tokens;
        });
      }),
    remove: (accountId) =>
      Effect.sync(() => {
        change(accountId);
        cache.delete(accountId);
        const current = loadBlobs();
        if (!(accountId in current)) {
          return undefined;
        }
        delete current[accountId];
        return writeBlobs();
      }).pipe(Effect.flatMap(logWriteFailure)),
    set: (accountId, tokens) =>
      Effect.sync(() => {
        cache.set(accountId, tokens);
        return change(accountId);
      }).pipe(Effect.flatMap((asOf) => persist(accountId, tokens, asOf))),
  };
};
