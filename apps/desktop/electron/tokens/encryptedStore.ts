import { TokenSet } from '@calendar/core';
import type { TokenStore } from '@calendar/google';
import { Effect, Schema, Semaphore } from 'effect';

/** The platform pieces the store needs — Electron's in production, fakes in tests. */
export interface EncryptedStoreDeps {
  /**
   * Rejects when the blob does not decrypt. `shouldReEncrypt` says the blob
   * was written under a key the platform has since replaced.
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

/**
 * TokenSets encrypted with the OS keychain-backed key, persisted as base64
 * blobs in one JSON file. Decisions:
 * - The blob map is read once and kept in memory: `get` used to re-read
 *   and re-parse the file plus a keychain round trip on every authed
 *   request, and `set` was a read-modify-write over the whole map while
 *   TokenManager's refresh lock is per account — two refreshes could lose
 *   a write. Decrypted TokenSets are cached per account.
 * - Encryption is asynchronous, so writes, removals and first reads take
 *   turns: a write must not land after a later one or after a removal, and
 *   a first read must not cache tokens a write has replaced while it
 *   decrypted. A cached read waits for nothing.
 * - Writes go through `writeFile`, which must be atomic (temp + rename).
 * - No encryption available: tokens live in memory for this session only
 *   and are never written — sign-in works, nothing persists, and the log
 *   says so once. A failed encryption keeps them in memory too, logged;
 *   it used to be a defect from a `never`-error `set`, killing the sync
 *   pass.
 * - A blob that no longer decrypts is logged at error level (the user
 *   appears signed out and should know why); the blob is left in place.
 *   One the platform asks to re-encrypt is written again under the
 *   current key, so a retired key never strands an account.
 */
export const makeEncryptedTokenStore = (deps: EncryptedStoreDeps): typeof TokenStore.Service => {
  let blobs: EncryptedBlobs | null = null;
  const cache = new Map<string, TokenSet>();
  const turns = Semaphore.makeUnsafe(1);
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

  /** Whether the file may be written; without encryption the log says why not, once. */
  const writable = Effect.gen(function* () {
    if (yield* Effect.promise(() => deps.isEncryptionAvailable().catch(() => false))) {
      return true;
    }
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      yield* Effect.logError(
        'safeStorage encryption unavailable: tokens are kept in memory for this session only',
      );
    }
    return false;
  });

  const writeBlobs = Effect.gen(function* () {
    try {
      deps.writeFile(JSON.stringify(loadBlobs()));
    } catch (error) {
      yield* Effect.logError('token store write failed', { error: String(error) });
    }
  });

  /** Encrypts an account's tokens into the file; on failure the file keeps what it had. */
  const persist = (accountId: string, tokens: TokenSet) =>
    Effect.gen(function* () {
      if (!(yield* writable)) {
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
      loadBlobs()[accountId] = encrypted.success.toString('base64');
      yield* writeBlobs;
    });

  return {
    get: (accountId) => {
      const cached = cache.get(accountId);
      if (cached) {
        return Effect.succeed(cached);
      }
      return turns.withPermits(1)(
        Effect.gen(function* () {
          // A write or another first read may have filled it meanwhile.
          const filled = cache.get(accountId);
          if (filled) {
            return filled;
          }
          const blob = loadBlobs()[accountId];
          if (!blob) {
            return null;
          }
          const decrypted = yield* attempt(async () => {
            const { result, shouldReEncrypt } = await deps.decrypt(Buffer.from(blob, 'base64'));
            return {
              shouldReEncrypt,
              tokens: Schema.decodeUnknownSync(TokenSet)(JSON.parse(result)),
            };
          });
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
            yield* persist(accountId, tokens);
          }
          return tokens;
        }),
      );
    },
    remove: (accountId) =>
      turns.withPermits(1)(
        Effect.gen(function* () {
          cache.delete(accountId);
          const current = loadBlobs();
          if (accountId in current) {
            delete current[accountId];
            if (yield* writable) {
              yield* writeBlobs;
            }
          }
        }),
      ),
    set: (accountId, tokens) =>
      turns.withPermits(1)(
        Effect.gen(function* () {
          cache.set(accountId, tokens);
          yield* persist(accountId, tokens);
        }),
      ),
  };
};
