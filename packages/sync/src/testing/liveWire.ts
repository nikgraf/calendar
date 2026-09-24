import { Account, TokenSet } from '@calendar/core';
import { AccountRepo } from '@calendar/db';
import { GOOGLE_SCOPES, TokenStore } from '@calendar/google';
import { Effect, Layer } from 'effect';
import { FetchHttpClient, type HttpClient } from 'effect/unstable/http';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { LIVE_CALENDAR_SCOPE } from './liveScratchRest.ts';

/**
 * The half of the live Google suite an app host needs to sign the test
 * account in: the real wire plus a token store that already holds its
 * refresh token. Kept free of Node and SQLite imports so the iOS bundle
 * (`EXPO_PUBLIC_CALENDAR_GOOGLE=live`) can carry it; `liveGoogle.ts`
 * adds the scratch service and the engine recipe for Node.
 */

/** The seeded account row; the token store holds the refresh token under it. */
export const LIVE_ACCOUNT_ID = 'acc-live';

/** What the desktop and iOS hosts read to sign the live account in (JSON on desktop, env on iOS). */
export interface LiveAccountSeed {
  readonly contactsEnabled: boolean;
  readonly email: string;
  readonly refreshToken: string;
  readonly tasksEnabled: boolean;
}

/** One store per refresh token: every layer built from a config shares the refreshed access token. */
const stores = new Map<string, Layer.Layer<TokenStore>>();

/**
 * The real wire plus a memory token store that already holds the live
 * account's refresh token. `expiresAt: 0` makes the first request refresh
 * — the same path a real sign-in takes once its access token aged.
 */
export const liveWireLayer = (
  seed: Pick<LiveAccountSeed, 'refreshToken'>,
  accountId = LIVE_ACCOUNT_ID,
): Layer.Layer<HttpClient.HttpClient | TokenStore> => {
  const key = `${accountId}:${seed.refreshToken}`;
  let store = stores.get(key);
  if (!store) {
    store = TokenStore.layerMemoryWith([
      [
        accountId,
        new TokenSet({
          accessToken: '',
          expiresAt: 0,
          refreshToken: seed.refreshToken,
          scopes: [...GOOGLE_SCOPES, LIVE_CALENDAR_SCOPE],
        }),
      ],
    ]);
    stores.set(key, store);
  }
  return Layer.mergeAll(FetchHttpClient.layer, store);
};

/** Upserts the live account row (idempotent), like `seedFixtureAccounts`. */
export const seedLiveAccount = (
  seed: Pick<LiveAccountSeed, 'email'> & Partial<LiveAccountSeed>,
  accountId = LIVE_ACCOUNT_ID,
): Effect.Effect<void, SqlError, AccountRepo> =>
  Effect.gen(function* () {
    const accounts = yield* AccountRepo;
    const existing = yield* accounts.get(accountId);
    yield* accounts.upsert(
      new Account({
        contactsEnabled: seed.contactsEnabled ?? false,
        createdAt: existing?.createdAt ?? Date.now(),
        email: seed.email,
        id: accountId,
        provider: 'google',
        status: 'ok',
        tasksEnabled: seed.tasksEnabled ?? true,
      }),
    );
  });
