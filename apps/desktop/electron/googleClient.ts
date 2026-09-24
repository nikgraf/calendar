import { readFileSync } from 'node:fs';
import { GuestNotifications, type TokenStore } from '@calendar/google';
import {
  type GoogleFixture,
  googleFixtureLayer,
  seedFixtureAccounts,
} from '@calendar/sync/testing/googleFixture';
import {
  type LiveAccountSeed,
  liveWireLayer,
  seedLiveAccount,
} from '@calendar/sync/testing/liveGoogle';
import { Effect, Layer } from 'effect';
import { FetchHttpClient, type HttpClient } from 'effect/unstable/http';
import { safeStorageTokenStore } from './tokens/safeStorageStore.ts';

const readJson = <A>(path: string): A => JSON.parse(readFileSync(path, 'utf8')) as A;

const fixture = (): GoogleFixture | undefined => {
  const path = process.env['CALENDAR_GOOGLE_FIXTURE'];
  return process.env['CALENDAR_GOOGLE'] === 'fixture' && path ? readJson(path) : undefined;
};

/**
 * `CALENDAR_GOOGLE=live` + `CALENDAR_GOOGLE_LIVE=<json>`: the live e2e
 * suite's account — real wire, a memory token store holding its refresh
 * token (the file lives in the run's temp userData dir and dies with it),
 * guest mail muted. The OAuth client comes from GOOGLE_DESKTOP_CLIENT_ID
 * as always.
 */
const live = (): LiveAccountSeed | undefined => {
  const path = process.env['CALENDAR_GOOGLE_LIVE'];
  return process.env['CALENDAR_GOOGLE'] === 'live' && path ? readJson(path) : undefined;
};

const googleFixture = fixture();
const googleLive = live();

/**
 * The Google wire: fetch plus the safeStorage token store, or — with
 * `CALENDAR_GOOGLE=fixture` — the in-process fake API and a token store
 * that already holds a token for every fixture account, so e2e can watch
 * queued writes push and temp ids get swapped without a Google account;
 * or, with `CALENDAR_GOOGLE=live`, the real API signed in as the live
 * test account.
 */
export const desktopGoogleLayer: Layer.Layer<HttpClient.HttpClient | TokenStore> = googleFixture
  ? googleFixtureLayer(googleFixture)
  : googleLive
    ? Layer.mergeAll(liveWireLayer(googleLive), Layer.succeed(GuestNotifications, 'none'))
    : Layer.mergeAll(safeStorageTokenStore, FetchHttpClient.layer);

/** Upserts the fixture's or the live account rows; a no-op otherwise. */
export const seedDesktopGoogleAccounts = googleFixture
  ? seedFixtureAccounts(googleFixture)
  : googleLive
    ? seedLiveAccount(googleLive)
    : Effect.void;
