import { Account } from '@calendar/core';
import { AccountRepo, ContactRepo, reposLayer, runMigrations, SyncStateRepo } from '@calendar/db';
import {
  type GcalPeoplePage,
  GoogleCalendarClient,
  type GoogleCalendarClientShape,
  GooglePeopleClient,
  type GooglePeopleClientShape,
  GoogleTasksClient,
  type GoogleTasksClientShape,
  InsufficientScopeError,
  SyncTokenExpiredError,
} from '@calendar/google';
import { RemindersClient, unavailableRemindersClient } from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { SyncEngine } from './engine.ts';
import { EventMutations } from './mutations.ts';

const inertCalendarClient: GoogleCalendarClientShape = {
  deleteEvent: () => Effect.void,
  getColors: () => Effect.succeed({ calendar: {} }),
  insertEvent: () => Effect.die('not used'),
  listCalendars: () => Effect.succeed({ items: [] }),
  listEvents: () => Effect.succeed({ items: [] }),
  patchCalendarListEntry: () => Effect.die('not used'),
  patchEvent: () => Effect.die('not used'),
};

const inertTasksClient: GoogleTasksClientShape = {
  deleteTask: () => Effect.die('not used'),
  insertTask: () => Effect.die('not used'),
  listTaskLists: () => Effect.die('not used'),
  listTasks: () => Effect.die('not used'),
  patchTask: () => Effect.die('not used'),
};

type Scripted = GcalPeoplePage | 'expired' | 'scope';

interface Call {
  readonly syncToken: string | undefined;
  readonly tier: 'connections' | 'other';
}

/** Scripted People client: each call shifts the next page of its tier. */
const peopleClient = (
  script: { connections: Array<Scripted>; other: Array<Scripted> },
  calls: Array<Call> = [],
): GooglePeopleClientShape => {
  const next = (tier: Call['tier'], syncToken: string | undefined) => {
    calls.push({ syncToken, tier });
    const page = (tier === 'connections' ? script.connections : script.other).shift();
    if (page === undefined) {
      return Effect.succeed({});
    }
    if (page === 'expired') {
      return Effect.fail(new SyncTokenExpiredError({ calendarId: '' }));
    }
    if (page === 'scope') {
      return Effect.fail(new InsufficientScopeError({ message: 'scope' }));
    }
    return Effect.succeed(page);
  };
  return {
    listConnections: ({ syncToken }) => next('connections', syncToken),
    listOtherContacts: ({ syncToken }) => next('other', syncToken),
  };
};

const testLayer = (people: GooglePeopleClientShape) =>
  SyncEngine.layer.pipe(
    Layer.provideMerge(EventMutations.layer),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(RemindersClient, unavailableRemindersClient('test'))),
    Layer.provideMerge(Layer.succeed(GoogleCalendarClient, inertCalendarClient)),
    Layer.provideMerge(Layer.succeed(GoogleTasksClient, inertTasksClient)),
    Layer.provideMerge(Layer.succeed(GooglePeopleClient, people)),
  );

const seedAccount = (contactsEnabled: boolean) =>
  Effect.gen(function* () {
    const accounts = yield* AccountRepo;
    yield* accounts.upsert(
      new Account({
        contactsEnabled,
        createdAt: 1,
        email: 'nik@example.com',
        id: 'acc-1',
        provider: 'google',
        status: 'ok',
        tasksEnabled: false,
      }),
    );
  });

const person = (resourceName: string, email: string, displayName?: string) => ({
  emailAddresses: [{ value: email }],
  ...(displayName ? { names: [{ displayName }] } : {}),
  resourceName,
});

const emails = (rows: ReadonlyArray<{ readonly email: string }>) => rows.map((row) => row.email);

describe('contacts sync', () => {
  it.effect('full pass caches both tiers, pages, and stores the sync tokens', () => {
    const calls: Array<Call> = [];
    const client = peopleClient(
      {
        connections: [
          { connections: [person('people/c1', 'alice@example.com', 'Alice')], nextPageToken: 'p2' },
          { connections: [person('people/c2', 'bob@example.com', 'Bob')], nextSyncToken: 'conn-1' },
        ],
        other: [
          {
            nextSyncToken: 'other-1',
            otherContacts: [person('otherContacts/o1', 'shop@example.com')],
          },
        ],
      },
      calls,
    );
    return Effect.gen(function* () {
      yield* seedAccount(true);
      yield* (yield* SyncEngine).syncAll();
      const rows = yield* (yield* ContactRepo).listByAccount('acc-1');
      expect(emails(rows).sort()).toEqual([
        'alice@example.com',
        'bob@example.com',
        'shop@example.com',
      ]);
      expect(rows.find((row) => row.email === 'shop@example.com')?.isOtherContact).toBe(true);
      const states = yield* SyncStateRepo;
      expect((yield* states.get('acc-1', 'contacts:connections'))?.syncToken).toBe('conn-1');
      expect((yield* states.get('acc-1', 'contacts:other'))?.syncToken).toBe('other-1');
      expect(calls.map((call) => call.syncToken)).toEqual([undefined, undefined, undefined]);
    }).pipe(Effect.provide(testLayer(client)));
  });

  it.effect('incremental pass upserts changes and removes tombstones', () => {
    const calls: Array<Call> = [];
    const client = peopleClient(
      {
        connections: [
          {
            connections: [
              person('people/c1', 'alice@example.com', 'Alice'),
              person('people/c2', 'bob@example.com', 'Bob'),
            ],
            nextSyncToken: 'conn-1',
          },
          {
            connections: [
              { metadata: { deleted: true }, resourceName: 'people/c2' },
              person('people/c1', 'alice@new.example', 'Alice'),
            ],
            nextSyncToken: 'conn-2',
          },
        ],
        other: [{ nextSyncToken: 'other-1', otherContacts: [] }, { nextSyncToken: 'other-2' }],
      },
      calls,
    );
    return Effect.gen(function* () {
      yield* seedAccount(true);
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      yield* engine.syncAll();
      const rows = yield* (yield* ContactRepo).listByAccount('acc-1');
      // Bob is gone; Alice's old address went with her re-sent person.
      expect(emails(rows)).toEqual(['alice@new.example']);
      expect(
        calls.filter((call) => call.tier === 'connections').map((call) => call.syncToken),
      ).toEqual([undefined, 'conn-1']);
      expect((yield* (yield* SyncStateRepo).get('acc-1', 'contacts:connections'))?.syncToken).toBe(
        'conn-2',
      );
    }).pipe(Effect.provide(testLayer(client)));
  });

  it.effect('a person re-sent without any email loses their cached rows', () => {
    const client = peopleClient({
      connections: [
        {
          connections: [person('people/c1', 'alice@example.com', 'Alice')],
          nextSyncToken: 'conn-1',
        },
        {
          connections: [{ names: [{ displayName: 'Alice' }], resourceName: 'people/c1' }],
          nextSyncToken: 'conn-2',
        },
      ],
      other: [{ nextSyncToken: 'other-1' }, { nextSyncToken: 'other-2' }],
    });
    return Effect.gen(function* () {
      yield* seedAccount(true);
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      yield* engine.syncAll();
      expect(yield* (yield* ContactRepo).listByAccount('acc-1')).toEqual([]);
      expect((yield* (yield* SyncStateRepo).get('acc-1', 'contacts:connections'))?.syncToken).toBe(
        'conn-2',
      );
    }).pipe(Effect.provide(testLayer(client)));
  });

  it.effect('an expired sync token triggers a full resync that replaces the tier', () => {
    const client = peopleClient({
      connections: [
        { connections: [person('people/c1', 'old@example.com')], nextSyncToken: 'conn-1' },
        'expired',
        { connections: [person('people/c3', 'fresh@example.com')], nextSyncToken: 'conn-3' },
      ],
      other: [{ nextSyncToken: 'other-1' }, { nextSyncToken: 'other-2' }],
    });
    return Effect.gen(function* () {
      yield* seedAccount(true);
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      yield* engine.syncAll();
      expect(emails(yield* (yield* ContactRepo).listByAccount('acc-1'))).toEqual([
        'fresh@example.com',
      ]);
      expect((yield* (yield* SyncStateRepo).get('acc-1', 'contacts:connections'))?.syncToken).toBe(
        'conn-3',
      );
    }).pipe(Effect.provide(testLayer(client)));
  });

  it.effect('flips contactsEnabled off when the scope turns out to be missing', () => {
    const client = peopleClient({ connections: ['scope'], other: [] });
    return Effect.gen(function* () {
      yield* seedAccount(true);
      yield* (yield* SyncEngine).syncAll();
      const [account] = yield* (yield* AccountRepo).list();
      expect(account?.contactsEnabled).toBe(false);
      expect(account?.status).toBe('ok');
    }).pipe(Effect.provide(testLayer(client)));
  });

  it.effect('does not touch the People API for accounts without the scopes', () => {
    const calls: Array<Call> = [];
    const client = peopleClient({ connections: [], other: [] }, calls);
    return Effect.gen(function* () {
      yield* seedAccount(false);
      yield* (yield* SyncEngine).syncAll();
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(testLayer(client)));
  });
});
