import { TokenSet } from '@calendar/core';
import type { TokenStore } from '@calendar/google';
import { Effect, Schema } from 'effect';

/** The platform pieces the store needs — Electron's in production, fakes in tests. */
export interface EncryptedStoreDeps {
  readonly decrypt: (blob: Buffer) => string;
  readonly encrypt: (text: string) => Buffer;
  /** False when the OS keychain-backed key is unavailable (e.g. a locked login keychain). */
  readonly isEncryptionAvailable: () => boolean;
  /** The persisted blob file, or null when there is none yet. */
  readonly readFile: () => string | null;
  /** Must replace the file atomically (temp file + rename): a crash mid-write must not truncate it. */
  readonly writeFile: (text: string) => void;
}

type EncryptedBlobs = Record<string, string>;

/**
 * TokenSets encrypted with the OS keychain-backed key, persisted as base64
 * blobs in one JSON file. Decisions:
 * - The blob map is read once and kept in memory: `get` used to re-read
 *   and re-parse the file plus a keychain round trip on every authed
 *   request, and `set` was a read-modify-write over the whole map while
 *   TokenManager's refresh lock is per account — two refreshes could lose
 *   a write. Decrypted TokenSets are cached per account.
 * - Writes go through `writeFile`, which must be atomic (temp + rename).
 * - No encryption available: tokens live in memory for this session only
 *   and are never written — sign-in works, nothing persists, and the log
 *   says so once. A throw out of encryptString used to be a defect from a
 *   `never`-error `set`, killing the sync pass.
 * - A blob that no longer decrypts is logged at error level (the user
 *   appears signed out and should know why); the blob is left in place.
 */
export const makeEncryptedTokenStore = (deps: EncryptedStoreDeps): typeof TokenStore.Service => {
  let blobs: EncryptedBlobs | null = null;
  const cache = new Map<string, TokenSet>();
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

  const persist = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (!deps.isEncryptionAvailable()) {
        if (!warnedUnavailable) {
          warnedUnavailable = true;
          yield* Effect.logError(
            'safeStorage encryption unavailable: tokens are kept in memory for this session only',
          );
        }
        return;
      }
      try {
        deps.writeFile(JSON.stringify(loadBlobs()));
      } catch (error) {
        yield* Effect.logError('token store write failed', { error: String(error) });
      }
    });

  return {
    get: (accountId) =>
      Effect.gen(function* () {
        const cached = cache.get(accountId);
        if (cached) {
          return cached;
        }
        const blob = loadBlobs()[accountId];
        if (!blob) {
          return null;
        }
        try {
          const json = deps.decrypt(Buffer.from(blob, 'base64'));
          const tokens = Schema.decodeUnknownSync(TokenSet)(JSON.parse(json));
          cache.set(accountId, tokens);
          return tokens;
        } catch (error) {
          yield* Effect.logError('stored tokens could not be decrypted', {
            accountId,
            error: String(error),
          });
          return null;
        }
      }),
    remove: (accountId) =>
      Effect.gen(function* () {
        cache.delete(accountId);
        const current = loadBlobs();
        if (accountId in current) {
          delete current[accountId];
          yield* persist();
        }
      }),
    set: (accountId, tokens) =>
      Effect.gen(function* () {
        cache.set(accountId, tokens);
        if (!deps.isEncryptionAvailable()) {
          yield* persist();
          return;
        }
        try {
          loadBlobs()[accountId] = deps
            .encrypt(JSON.stringify(Schema.encodeSync(TokenSet)(tokens)))
            .toString('base64');
        } catch (error) {
          yield* Effect.logError('token encryption failed; kept in memory only', {
            accountId,
            error: String(error),
          });
          return;
        }
        yield* persist();
      }),
  };
};
