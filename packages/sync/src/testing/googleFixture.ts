import { Account, TokenSet } from '@calendar/core';
import { AccountRepo } from '@calendar/db';
import {
  type GcalCalendarListEntry,
  type GcalEvent,
  type GcalTask,
  type GcalTaskList,
  GOOGLE_SCOPES,
  TokenStore,
} from '@calendar/google';
import { Effect, Layer } from 'effect';
import type { HttpClient } from 'effect/unstable/http';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { FakeGoogle } from './fakeGoogle.ts';

/**
 * A Google account and its server-side data for an app running against
 * the in-process fake (desktop `CALENDAR_GOOGLE=fixture`, iOS
 * `EXPO_PUBLIC_CALENDAR_GOOGLE=fixture`). Only the account rows are
 * seeded locally; calendars, lists and tasks arrive through the normal
 * first sync, so the app exercises the same pull and push paths as
 * against Google itself — including the temp-id swap after a task
 * create.
 */
export interface GoogleFixture {
  readonly accounts: ReadonlyArray<{
    readonly email: string;
    readonly id: string;
    readonly tasksEnabled: boolean;
  }>;
  readonly calendars?: ReadonlyArray<GcalCalendarListEntry> | undefined;
  /** Events per calendar id, as Google would list them (the fake assigns etags). */
  readonly events?: Readonly<Record<string, ReadonlyArray<GcalEvent>>> | undefined;
  readonly taskLists?: ReadonlyArray<GcalTaskList> | undefined;
  /** Tasks per list id; `due` as RFC 3339 midnight UTC, like the API. */
  readonly tasks?: Readonly<Record<string, ReadonlyArray<GcalTask>>> | undefined;
}

/** A token the real TokenManager accepts without ever refreshing. */
const FIXTURE_TOKENS = new TokenSet({
  accessToken: 'fixture-token',
  expiresAt: Date.UTC(2999, 0, 1),
  refreshToken: 'fixture-refresh',
  scopes: GOOGLE_SCOPES,
});

export const fakeGoogleFrom = (fixture: GoogleFixture): FakeGoogle => {
  const fake = new FakeGoogle({
    calendars: fixture.calendars ?? [],
    live: true,
    taskLists: fixture.taskLists ?? [],
  });
  for (const [calendarId, events] of Object.entries(fixture.events ?? {})) {
    for (const event of events) {
      fake.putEvent(calendarId, event);
    }
  }
  for (const [listId, tasks] of Object.entries(fixture.tasks ?? {})) {
    for (const task of tasks) {
      fake.putTask(listId, task);
    }
  }
  return fake;
};

/**
 * The fake as the app's HttpClient plus a token store that already holds
 * a token for every fixture account: the real TokenManager, request core
 * and clients run unchanged, only the wire is faked.
 */
export const googleFixtureLayer = (
  fixture: GoogleFixture,
): Layer.Layer<HttpClient.HttpClient | TokenStore> =>
  Layer.mergeAll(
    fakeGoogleFrom(fixture).httpLayer,
    TokenStore.layerMemoryWith(
      fixture.accounts.map((account) => [account.id, FIXTURE_TOKENS] as const),
    ),
  );

/** Upserts the fixture's account rows (idempotent; run before the engine starts). */
export const seedFixtureAccounts = (
  fixture: GoogleFixture,
): Effect.Effect<void, SqlError, AccountRepo> =>
  Effect.gen(function* () {
    const accounts = yield* AccountRepo;
    for (const entry of fixture.accounts) {
      const existing = yield* accounts.get(entry.id);
      yield* accounts.upsert(
        new Account({
          contactsEnabled: false,
          createdAt: existing?.createdAt ?? Date.now(),
          email: entry.email,
          id: entry.id,
          provider: 'google',
          status: 'ok',
          tasksEnabled: entry.tasksEnabled,
        }),
      );
    }
  });
