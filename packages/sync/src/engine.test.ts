import { Account, eventsScope, plainDateToUtcMs } from '@calendar/core';
import {
  AccountRepo,
  CalendarRepo,
  EventRepo,
  reposLayer,
  runMigrations,
  SyncStateRepo,
} from '@calendar/db';
import {
  GoogleCalendarClient,
  ReauthRequiredError,
  SyncTokenExpiredError,
  type GcalCalendarListPage,
  type GcalEventsPage,
  type GoogleCalendarClientShape,
} from '@calendar/google';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { SyncEngine } from './engine.ts';

const calendarListPage: GcalCalendarListPage = {
  items: [
    {
      accessRole: 'owner',
      backgroundColor: '#16a765',
      id: 'cal-1',
      primary: true,
      selected: true,
      summary: 'Personal',
      timeZone: 'Europe/Vienna',
    },
  ],
  nextSyncToken: 'cal-sync-1',
};

const timedItem = (id: string, hour: number) => ({
  end: { dateTime: `2026-07-02T${hour + 1}:00:00Z` },
  etag: `"${id}"`,
  id,
  start: { dateTime: `2026-07-02T${hour}:00:00Z` },
  status: 'confirmed',
  summary: `Event ${id}`,
});

/** Scripted client: each listEvents call shifts the next page. */
const stubClient = (
  eventPages: Array<GcalEventsPage | 'sync-token-expired' | 'reauth'>,
  calls: Array<{ syncToken?: string | undefined }> = [],
): GoogleCalendarClientShape => ({
  deleteEvent: () => Effect.die('not used'),
  getColors: () => Effect.succeed({ calendar: {} }),
  insertEvent: () => Effect.die('not used'),
  listCalendars: () => Effect.succeed(calendarListPage),
  listEvents: ({ params }) => {
    calls.push({ syncToken: params.syncToken });
    const next = eventPages.shift();
    if (next === undefined) {
      return Effect.succeed({ items: [] });
    }
    if (next === 'sync-token-expired') {
      return Effect.fail(new SyncTokenExpiredError({ calendarId: 'cal-1' }));
    }
    if (next === 'reauth') {
      return Effect.fail(new ReauthRequiredError({ accountId: 'acc-1' }));
    }
    return Effect.succeed(next);
  },
  patchEvent: () => Effect.die('not used'),
});

const engineLayer = (client: GoogleCalendarClientShape) =>
  SyncEngine.layer.pipe(
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(GoogleCalendarClient, client)),
  );

const seedAccount = Effect.gen(function* () {
  const accounts = yield* AccountRepo;
  yield* accounts.upsert(
    new Account({
      createdAt: 1,
      email: 'nik@example.com',
      id: 'acc-1',
      status: 'ok',
    }),
  );
});

describe('SyncEngine', () => {
  it.effect('initial sync persists calendars, paged events, and sync tokens', () => {
    const calls: Array<{ syncToken?: string | undefined }> = [];
    const client = stubClient(
      [
        { items: [timedItem('evt-1', 10)], nextPageToken: 'page-2' },
        { items: [timedItem('evt-2', 12)], nextSyncToken: 'evt-sync-1' },
      ],
      calls,
    );
    return Effect.gen(function* () {
      yield* seedAccount;
      const engine = yield* SyncEngine;
      yield* engine.syncAll();

      const calendars = yield* (yield* CalendarRepo).list('acc-1');
      expect(calendars).toHaveLength(1);
      expect(calendars[0]!.colorHex).toBe('#16a765');

      const window = yield* (yield* EventRepo).getWindow(0, plainDateToUtcMs('2030-01-01'));
      expect(window.singles.map((event) => event.id).sort()).toEqual(['evt-1', 'evt-2']);

      const state = yield* (yield* SyncStateRepo).get('acc-1', eventsScope('cal-1'));
      expect(state?.syncToken).toBe('evt-sync-1');
      // Initial pass sends no sync token.
      expect(calls[0]!.syncToken).toBeUndefined();
    }).pipe(Effect.provide(engineLayer(client)));
  });

  it.effect('incremental sync applies updates and cancellation tombstones', () => {
    const calls: Array<{ syncToken?: string | undefined }> = [];
    const client = stubClient(
      [
        // Pass 1: initial.
        {
          items: [timedItem('evt-1', 10), timedItem('evt-2', 12)],
          nextSyncToken: 'sync-1',
        },
        // Pass 2: incremental — evt-2 cancelled (plain event → deletion).
        {
          items: [
            { ...timedItem('evt-1', 11), summary: 'Moved' },
            { id: 'evt-2', status: 'cancelled' },
          ],
          nextSyncToken: 'sync-2',
        },
      ],
      calls,
    );
    return Effect.gen(function* () {
      yield* seedAccount;
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      yield* engine.syncAll();

      const window = yield* (yield* EventRepo).getWindow(0, plainDateToUtcMs('2030-01-01'));
      expect(window.singles).toHaveLength(1);
      expect(window.singles[0]!.title).toBe('Moved');
      expect(calls[1]!.syncToken).toBe('sync-1');
    }).pipe(Effect.provide(engineLayer(client)));
  });

  it.effect('410 triggers a full resync that purges stale rows', () => {
    const client = stubClient([
      // Pass 1: initial with two events.
      {
        items: [timedItem('evt-old', 10), timedItem('evt-keep', 12)],
        nextSyncToken: 'sync-1',
      },
      // Pass 2: incremental fails with 410…
      'sync-token-expired',
      // …then the full resync only returns evt-keep.
      { items: [timedItem('evt-keep', 12)], nextSyncToken: 'sync-2' },
    ]);
    return Effect.gen(function* () {
      yield* seedAccount;
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      // The purge compares synced_at against the pass start — advance time
      // so the second pass is distinguishable from the first.
      yield* TestClock.adjust('5 minutes');
      yield* engine.syncAll();

      const window = yield* (yield* EventRepo).getWindow(0, plainDateToUtcMs('2030-01-01'));
      expect(window.singles.map((event) => event.id)).toEqual(['evt-keep']);

      const state = yield* (yield* SyncStateRepo).get('acc-1', eventsScope('cal-1'));
      expect(state?.syncToken).toBe('sync-2');
    }).pipe(Effect.provide(engineLayer(client)));
  });

  it.effect('flags the account when Google demands re-auth', () => {
    const client = stubClient(['reauth']);
    return Effect.gen(function* () {
      yield* seedAccount;
      const engine = yield* SyncEngine;
      yield* engine.syncAll();

      const accounts = yield* (yield* AccountRepo).list();
      expect(accounts[0]!.status).toBe('reauth_required');
    }).pipe(Effect.provide(engineLayer(client)));
  });
});
