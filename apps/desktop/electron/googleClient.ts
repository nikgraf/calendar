import { readFileSync } from 'node:fs';
import type { TokenStore } from '@calendar/google';
import {
  type GoogleFixture,
  googleFixtureLayer,
  seedFixtureAccounts,
} from '@calendar/sync/testing/googleFixture';
import { Effect, Layer } from 'effect';
import { FetchHttpClient, type HttpClient } from 'effect/unstable/http';
import { safeStorageTokenStore } from './tokens/safeStorageStore.ts';

const fixture = (): GoogleFixture | undefined => {
  const path = process.env['CALENDAR_GOOGLE_FIXTURE'];
  if (process.env['CALENDAR_GOOGLE'] !== 'fixture' || !path) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, 'utf8')) as GoogleFixture;
};

const googleFixture = fixture();

/**
 * The Google wire: fetch plus the safeStorage token store, or — with
 * `CALENDAR_GOOGLE=fixture` — the in-process fake API and a token store
 * that already holds a token for every fixture account, so e2e can watch
 * queued writes push and temp ids get swapped without a Google account.
 */
export const desktopGoogleLayer: Layer.Layer<HttpClient.HttpClient | TokenStore> = googleFixture
  ? googleFixtureLayer(googleFixture)
  : Layer.mergeAll(safeStorageTokenStore, FetchHttpClient.layer);

/** Upserts the fixture's accounts; a no-op without a fixture. */
export const seedDesktopGoogleFixture = googleFixture
  ? seedFixtureAccounts(googleFixture)
  : Effect.void;
