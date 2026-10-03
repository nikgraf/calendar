import {
  type AppleCalendarClientShape,
  makeFakeAppleCalendarClient,
} from '@calendar/apple-calendar';
import {
  Account,
  APPLE_CALENDAR_ACCOUNT_ID,
  APPLE_REMINDERS_ACCOUNT_ID,
  encodeMirrorUrl,
  MIRROR_PRESETS,
  MIRROR_PROPERTY_KEY,
  type MirrorDefinition,
  mirrorKeyHash,
  mirrorTag,
  parseMirrorUrl,
} from '@calendar/core';
import { AccountRepo, EventRepo, reposLayer, runMigrations } from '@calendar/db';
import {
  GoogleCalendarClient,
  GooglePeopleClient,
  GoogleTasksClient,
  TokenStore,
} from '@calendar/google';
import {
  makeFakeRemindersClient,
  RemindersClient,
  type RemindersClientShape,
} from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer, type Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { describe } from 'vitest';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { SyncEngine } from './engine.ts';
import { appleMirrorDestination, MirrorWritePace } from './mirrorDestination.ts';
import { Mirrors } from './mirrors.ts';
import { readMirrorLocals, updateMirrorLocal, writeMirrors } from './mirrorSettings.ts';
import { EventMutations } from './mutations.ts';
import { FakeGoogle } from './testing/fakeGoogle.ts';

/**
 * Calendar mirrors end to end below the UI: the real engine, clients and
 * repos, the fake Google API and the fake EventKit store. A "device" is
 * its own database, engine and Mirrors service; two devices share the
 * providers, as a Mac and an iPhone do — which is where mirrors can go
 * wrong, so most tests here run two of them.
 */

// The clock is the test clock, so these dates never decay. It sits in the
// past on purpose: the fake EventKit stores stamp their writes with the
// wall clock, and the engine's Reminders delta pass must find them newer.
const NOW = Date.parse('2025-03-12T08:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

const WORK = 'work@example.com';
const DEST = 'shared@group.calendar.google.com';

const newGoogle = () =>
  new FakeGoogle({
    calendars: [
      { accessRole: 'owner', id: WORK, primary: true, summary: 'Work' },
      { accessRole: 'owner', id: DEST, summary: 'Shared' },
    ],
    taskLists: [{ id: 'list-1', title: 'My Tasks' }],
  });

const meeting = (id: string, startMs: number, extra: Record<string, unknown> = {}) => ({
  end: { dateTime: iso(startMs + HOUR) },
  id,
  start: { dateTime: iso(startMs) },
  status: 'confirmed',
  summary: `Meeting ${id}`,
  ...extra,
});

const appleCalendar = (id: string, title: string) => ({
  allowsModifications: true,
  id,
  isDefault: false,
  sourceTitle: 'iCloud',
  sourceType: 'calDAV' as const,
  title,
  type: 'calDAV' as const,
});

const newApple = () =>
  makeFakeAppleCalendarClient({
    calendars: [appleCalendar('ek-family', 'Family'), appleCalendar('ek-private', 'Private')],
  });

const newReminders = () =>
  makeFakeRemindersClient({
    lists: [{ allowsModifications: true, id: 'rem-household', title: 'Household' }],
  });

const deviceLayer = (
  google: FakeGoogle,
  apple: AppleCalendarClientShape,
  reminders: RemindersClientShape,
) =>
  Mirrors.layer.pipe(
    Layer.provideMerge(SyncEngine.layer),
    Layer.provideMerge(EventMutations.layer),
    Layer.provideMerge(appleCalendarServicesLayer(apple)),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(RemindersClient, reminders)),
    Layer.provideMerge(GoogleCalendarClient.layer),
    Layer.provideMerge(GoogleTasksClient.layer),
    Layer.provideMerge(GooglePeopleClient.layer),
    Layer.provideMerge(TokenStore.layerMemory),
    Layer.provideMerge(google.layer),
  );

type DeviceServices = Layer.Success<ReturnType<typeof deviceLayer>>;
type OnDevice = <A, E>(effect: Effect.Effect<A, E, DeviceServices>) => Effect.Effect<A, E>;

const account = (id: string, provider: 'apple' | 'google', email = '') =>
  new Account({
    contactsEnabled: false,
    createdAt: 1,
    email,
    id,
    provider,
    status: 'ok',
    tasksEnabled: provider === 'google',
  });

interface World {
  readonly apple: ReturnType<typeof makeFakeAppleCalendarClient>;
  readonly google: FakeGoogle;
  readonly reminders: ReturnType<typeof makeFakeRemindersClient>;
}

/** A device signed in to everything, with one finished sync pass. */
const makeDevice = (world: World) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      deviceLayer(world.google, world.apple.client, world.reminders.client),
    );
    const on: OnDevice = (effect) => Effect.provide(effect, context);
    yield* on(
      Effect.gen(function* () {
        const accounts = yield* AccountRepo;
        yield* accounts.upsert(account('acc-1', 'google', 'nik@example.com'));
        yield* accounts.upsert(account(APPLE_CALENDAR_ACCOUNT_ID, 'apple'));
        yield* accounts.upsert(account(APPLE_REMINDERS_ACCOUNT_ID, 'apple'));
        yield* (yield* SyncEngine).syncAll();
      }),
    );
    return on;
  });

/** A pass, then room for the change watchers to see what it brought. */
const sync = Effect.flatMap(SyncEngine, (engine) => engine.syncAll()).pipe(
  Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 20 })),
);
const runMirrors = (options?: { readonly force?: boolean }) =>
  Effect.flatMap(Mirrors, (mirrors) => mirrors.run(options));
const statusOf = (id = 'mirror-1') =>
  Effect.map(
    Effect.flatMap(Mirrors, (mirrors) => mirrors.list()),
    (views) => {
      const view = views.find((entry) => entry.definition.id === id);
      return view === undefined
        ? undefined
        : { reason: view.status.reason, state: view.status.state };
    },
  );

const mirror = (overrides: Partial<MirrorDefinition> = {}): MirrorDefinition => ({
  busyLabel: 'Busy',
  destination: { calendarId: DEST, email: 'nik@example.com', kind: 'google' },
  ...MIRROR_PRESETS.titleLocation,
  id: 'mirror-1',
  monthsAhead: 3,
  name: 'Shared',
  sources: [{ calendarId: WORK, email: 'nik@example.com', kind: 'google' }],
  timeZone: 'UTC',
  updatedAt: NOW,
  ...overrides,
});

/**
 * Gives a device a definition the way an import does, switched on there.
 * Written directly rather than through `setEnabled`, which would kick a
 * run of its own: these tests say exactly when each device runs.
 */
const adopt = (definition: MirrorDefinition) =>
  Effect.gen(function* () {
    yield* writeMirrors([definition]);
    yield* updateMirrorLocal(definition.id, () => ({ enabled: true }));
  });

const writes = (google: FakeGoogle): number =>
  google.requests.filter((request) => request.method !== 'GET' && request.url.includes('/events'))
    .length;

const copies = (google: FakeGoogle) =>
  google.eventsOf(DEST).map((event) => ({
    description: event.description,
    location: event.location,
    start: event.start?.dateTime,
    title: event.summary,
  }));

/** One world, the test clock at NOW, no pause between Google writes. */
const scenario = <A, E>(body: (world: World) => Effect.Effect<A, E, Scope.Scope>) => {
  const world: World = { apple: newApple(), google: newGoogle(), reminders: newReminders() };
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    return yield* body(world);
  }).pipe(Effect.provideService(MirrorWritePace, 0), Effect.scoped);
};

describe('calendar mirrors', () => {
  it.effect('copies the allowed fields under derived ids and then writes nothing', () =>
    scenario((world) =>
      Effect.gen(function* () {
        world.google.putEvent(
          WORK,
          meeting('a', NOW + 2 * HOUR, {
            attendees: [{ email: 'boss@example.com', responseStatus: 'accepted' }],
            description: 'Agenda: the acquisition',
            location: 'Room 4',
            reminders: { overrides: [{ method: 'popup', minutes: 10 }], useDefault: false },
          }),
        );
        world.google.putEvent(
          WORK,
          meeting('declined', NOW + 5 * HOUR, {
            attendees: [{ email: 'nik@example.com', responseStatus: 'declined', self: true }],
          }),
        );
        world.google.putEvent(WORK, meeting('far', NOW + 400 * DAY));
        const mac = yield* makeDevice(world);
        yield* mac(Effect.flatMap(Mirrors, (mirrors) => mirrors.save(mirror())));
        yield* mac(runMirrors());

        const [copy] = world.google.eventsOf(DEST);
        expect(world.google.eventsOf(DEST)).toHaveLength(1);
        expect(copy?.id).toBe(`slnvmr${mirrorKeyHash('mirror-1', `g|${WORK}|a`)}`);
        expect(copy).toMatchObject({ location: 'Room 4', summary: 'Meeting a' });
        // Nothing the definition does not name: no description, no guests, no reminders.
        expect(copy?.description).toBeUndefined();
        expect(copy?.attendees).toBeUndefined();
        expect(copy?.reminders).toEqual({ overrides: [], useDefault: false });
        expect(copy?.extendedProperties?.private?.[MIRROR_PROPERTY_KEY]).toMatch(
          new RegExp(`^${mirrorTag('mirror-1')}\\.${NOW}\\.`),
        );
        expect(yield* mac(statusOf())).toEqual({ reason: undefined, state: 'upToDate' });

        const before = writes(world.google);
        yield* mac(sync);
        yield* mac(runMirrors());
        expect(writes(world.google)).toBe(before);
        // The copy is hidden from everything the app draws.
        const window = yield* mac(
          Effect.flatMap(EventRepo, (events) => events.getWindow(NOW, NOW + DAY)),
        );
        expect(window.singles.map((event) => event.id).sort()).toEqual(['a', 'declined']);
      }),
    ),
  );

  it.effect('follows a rename and a deletion, and a switched-off field leaves the copy', () =>
    scenario((world) =>
      Effect.gen(function* () {
        world.google.putEvent(WORK, meeting('a', NOW + 2 * HOUR, { location: 'Room 4' }));
        world.google.putEvent(WORK, meeting('b', NOW + 4 * HOUR));
        const mac = yield* makeDevice(world);
        const mirrors = yield* mac(Mirrors);
        yield* mirrors.save(mirror());
        yield* mirrors.run();
        expect(copies(world.google).map((copy) => copy.title)).toEqual(['Meeting a', 'Meeting b']);

        world.google.putEvent(
          WORK,
          meeting('a', NOW + 2 * HOUR, { location: 'Room 4', summary: 'Renamed' }),
        );
        world.google.cancelEvent(WORK, 'b');
        yield* mac(sync);
        yield* mirrors.run();
        expect(copies(world.google)).toMatchObject([{ location: 'Room 4', title: 'Renamed' }]);

        // Location switched off: a PATCH would have left it on the shared copy.
        yield* TestClock.adjust('1 second');
        yield* mirrors.save(
          mirror({ fields: { description: false, location: false, title: true } }),
        );
        yield* mirrors.run();
        expect(copies(world.google)).toMatchObject([{ location: undefined, title: 'Renamed' }]);
      }),
    ),
  );

  it.effect('writes availability as merged blocks that name nothing', () =>
    scenario((world) =>
      Effect.gen(function* () {
        world.google.putEvent(WORK, meeting('a', NOW + 2 * HOUR, { location: 'Room 4' }));
        world.google.putEvent(
          WORK,
          meeting('b', NOW + 2 * HOUR + HOUR / 2, { visibility: 'private' }),
        );
        world.google.putEvent(
          WORK,
          meeting('free', NOW + 6 * HOUR, { transparency: 'transparent' }),
        );
        const mac = yield* makeDevice(world);
        const mirrors = yield* mac(Mirrors);
        yield* mirrors.save(mirror({ ...MIRROR_PRESETS.availability }));
        yield* mirrors.run();
        const [block] = world.google.eventsOf(DEST);
        expect(copies(world.google)).toMatchObject([
          { description: undefined, location: undefined, title: 'Busy' },
        ]);
        expect(Date.parse(block?.start?.dateTime ?? '')).toBe(NOW + 2 * HOUR);
        expect(Date.parse(block?.end?.dateTime ?? '')).toBe(NOW + 3 * HOUR + HOUR / 2);
      }),
    ),
  );

  it.effect(
    'a second device agrees: no writes, no duplicates, even before it pulled the copies',
    () =>
      scenario((world) =>
        Effect.gen(function* () {
          world.google.putEvent(WORK, meeting('a', NOW + 2 * HOUR));
          world.google.putEvent(WORK, meeting('b', NOW + 4 * HOUR));
          const mac = yield* makeDevice(world);
          // The phone synced before the Mac wrote anything: it holds no copy rows.
          const phone = yield* makeDevice(world);
          const definition = yield* mac(
            Effect.flatMap(Mirrors, (mirrors) => mirrors.save(mirror())),
          );
          yield* mac(runMirrors());
          expect(world.google.eventsOf(DEST)).toHaveLength(2);

          yield* phone(adopt(definition.definition));
          yield* phone(runMirrors());
          // Its inserts met the derived ids (409) and became replaces: still two events.
          expect(world.google.eventsOf(DEST)).toHaveLength(2);
          expect(yield* phone(statusOf())).toEqual({ reason: undefined, state: 'upToDate' });

          // Once both hold the rows, neither writes again.
          yield* mac(sync);
          yield* phone(sync);
          const before = writes(world.google);
          yield* mac(runMirrors());
          yield* phone(runMirrors());
          expect(writes(world.google)).toBe(before);
        }),
      ),
  );

  it.effect('a device that has not synced lately stands back', () =>
    scenario((world) =>
      Effect.gen(function* () {
        world.google.putEvent(WORK, meeting('a', NOW + 2 * HOUR));
        const mac = yield* makeDevice(world);
        const phone = yield* makeDevice(world);
        const saved = yield* mac(Effect.flatMap(Mirrors, (mirrors) => mirrors.save(mirror())));
        yield* mac(runMirrors());

        // The phone was offline for a while; meanwhile the source moved on.
        yield* TestClock.adjust('6 minutes');
        world.google.cancelEvent(WORK, 'a');
        world.google.putEvent(WORK, meeting('c', NOW + 8 * HOUR));
        yield* mac(sync);
        yield* mac(runMirrors());
        expect(copies(world.google).map((copy) => copy.title)).toEqual(['Meeting c']);

        const before = writes(world.google);
        yield* phone(adopt(saved.definition));
        yield* phone(runMirrors());
        expect(writes(world.google)).toBe(before);
        expect(yield* phone(statusOf())).toEqual({ reason: 'syncing', state: 'waiting' });
        // After its own pull it agrees with the Mac.
        yield* phone(sync);
        yield* phone(runMirrors());
        expect(copies(world.google).map((copy) => copy.title)).toEqual(['Meeting c']);
      }),
    ),
  );

  it.effect('a device on an older definition stands back until it gets the newer one', () =>
    scenario((world) =>
      Effect.gen(function* () {
        world.google.putEvent(WORK, meeting('a', NOW + 2 * HOUR, { location: 'Room 4' }));
        const mac = yield* makeDevice(world);
        const phone = yield* makeDevice(world);
        const first = yield* mac(Effect.flatMap(Mirrors, (mirrors) => mirrors.save(mirror())));
        yield* mac(runMirrors());
        yield* phone(sync);
        yield* phone(adopt(first.definition));
        yield* phone(runMirrors());

        // The Mac drops the location; the phone still has the old definition.
        yield* TestClock.adjust('1 second');
        const second = yield* mac(
          Effect.flatMap(Mirrors, (mirrors) =>
            mirrors.save(mirror({ fields: { description: false, location: false, title: true } })),
          ),
        );
        yield* mac(runMirrors());
        expect(copies(world.google)[0]?.location).toBeUndefined();

        yield* phone(sync);
        const before = writes(world.google);
        yield* phone(runMirrors());
        expect(writes(world.google)).toBe(before);
        expect(yield* phone(statusOf())).toEqual({ reason: 'newerDefinition', state: 'paused' });

        yield* phone(writeMirrors([second.definition]));
        yield* phone(runMirrors());
        expect(yield* phone(statusOf())).toEqual({ reason: undefined, state: 'upToDate' });
        expect(writes(world.google)).toBe(before);
      }),
    ),
  );

  it.effect('a stale device’s insert never puts an older definition’s content back', () =>
    scenario((world) =>
      Effect.gen(function* () {
        world.google.putEvent(WORK, meeting('a', NOW + 2 * HOUR, { location: 'Room 4' }));
        const mac = yield* makeDevice(world);
        // The phone synced before any copy existed: it holds no copy rows,
        // and its pull is fresh enough to pass the gate.
        const phone = yield* makeDevice(world);
        const first = yield* mac(Effect.flatMap(Mirrors, (mirrors) => mirrors.save(mirror())));
        yield* phone(adopt(first.definition));
        yield* mac(runMirrors());
        // The Mac drops the location and rewrites the copy under revision two.
        yield* TestClock.adjust('1 second');
        yield* mac(
          Effect.flatMap(Mirrors, (mirrors) =>
            mirrors.save(mirror({ fields: { description: false, location: false, title: true } })),
          ),
        );
        yield* mac(runMirrors());
        expect(copies(world.google)).toMatchObject([{ location: undefined }]);

        // The phone's insert meets the id (409). Looking first, it finds
        // the newer revision and stands back instead of replacing.
        yield* phone(runMirrors());
        expect(copies(world.google)).toMatchObject([{ location: undefined, title: 'Meeting a' }]);
        expect(yield* phone(statusOf())).toEqual({ reason: 'newerDefinition', state: 'paused' });
      }),
    ),
  );

  it.effect(
    'a definition that excludes everything wins: the stale device trips its own breaker',
    () =>
      scenario((world) =>
        Effect.gen(function* () {
          world.google.putEvent(
            WORK,
            meeting('a', NOW + 2 * HOUR, { transparency: 'transparent' }),
          );
          const mac = yield* makeDevice(world);
          const phone = yield* makeDevice(world);
          // The preset copies events marked free; the change below leaves them out.
          const first = yield* mac(Effect.flatMap(Mirrors, (mirrors) => mirrors.save(mirror())));
          yield* mac(runMirrors());
          yield* phone(sync);
          yield* phone(adopt(first.definition));
          yield* phone(runMirrors());
          expect(world.google.eventsOf(DEST)).toHaveLength(1);

          // The Mac leaves free events out: every copy goes, and nothing is
          // left to carry the new revision.
          yield* TestClock.adjust('1 second');
          yield* mac(
            Effect.flatMap(Mirrors, (mirrors) =>
              mirrors.save(
                mirror({ filters: { ...MIRROR_PRESETS.titleLocation.filters, free: 'skip' } }),
              ),
            ),
          );
          yield* mac(runMirrors());
          expect(world.google.eventsOf(DEST)).toHaveLength(0);

          for (let round = 0; round < 3; round++) {
            yield* phone(sync);
            yield* phone(runMirrors());
            yield* mac(sync);
            yield* mac(runMirrors());
          }
          // The phone wrote the excluded copy back twice and refused the
          // third; the Mac deleted it each time and never paused itself.
          expect(world.google.eventsOf(DEST)).toHaveLength(0);
          expect(yield* phone(statusOf())).toEqual({ reason: 'rewriteLoop', state: 'paused' });
          expect(yield* mac(statusOf())).toEqual({ reason: undefined, state: 'upToDate' });
        }),
      ),
  );

  it.effect('moving a mirror to another calendar takes its copies out of the old one', () =>
    scenario((world) =>
      Effect.gen(function* () {
        world.google.putEvent(WORK, meeting('a', NOW + 2 * HOUR));
        const mac = yield* makeDevice(world);
        const mirrors = yield* mac(Mirrors);
        yield* mirrors.save(mirror());
        yield* mirrors.run();
        expect(world.google.eventsOf(DEST)).toHaveLength(1);
        yield* TestClock.adjust('1 second');
        yield* mirrors.save(
          mirror({ destination: { kind: 'apple', source: 'iCloud', title: 'Family' } }),
        );
        yield* mirrors.run();
        expect(world.google.eventsOf(DEST)).toHaveLength(0);
        const family = [...world.apple.state.series.values()].filter(
          (series) => series.event.calendarId === 'ek-family',
        );
        expect(family).toHaveLength(1);
      }),
    ),
  );

  it.effect('an Apple write that is refused stays pending instead of counting as done', () =>
    scenario((world) =>
      Effect.gen(function* () {
        const calendar = {
          accessRole: 'owner' as const,
          accountId: APPLE_CALENDAR_ACCOUNT_ID,
          colorHex: '#000000',
          id: 'ek-nope',
          isPrimary: false,
          isVisible: true,
          provider: 'apple' as const,
          summary: 'Gone',
          timeZone: 'UTC',
        };
        const destination = appleMirrorDestination(world.apple.client, calendar as never);
        const copy = {
          allDay: false,
          contentHash: '0123456789abcdef',
          description: undefined,
          endDate: undefined,
          endUtc: NOW + HOUR,
          keyHash: mirrorKeyHash('m', 'k'),
          location: undefined,
          startDate: undefined,
          startUtc: NOW,
          title: 'Copy',
        };
        const result = yield* destination.apply(
          [{ copy, kind: 'create' }],
          { rev: 1, tag: mirrorTag('m'), timeZone: 'UTC' },
          Number.MAX_SAFE_INTEGER,
        );
        expect(result).toMatchObject({ applied: 0, failedIndices: [0], processed: 1 });
      }),
    ),
  );

  it.effect('stamps one copy when only the definition’s revision changed', () =>
    scenario((world) =>
      Effect.gen(function* () {
        world.google.putEvent(WORK, meeting('a', NOW + 2 * HOUR));
        world.google.putEvent(WORK, meeting('b', NOW + 4 * HOUR));
        world.google.putEvent(WORK, meeting('gone', NOW + 400 * DAY));
        const mac = yield* makeDevice(world);
        const mirrors = yield* mac(Mirrors);
        yield* mirrors.save(mirror());
        yield* mirrors.run();
        // A longer window changes what the mirror writes, but none of today's copies.
        yield* TestClock.adjust('1 second');
        const before = writes(world.google);
        yield* mirrors.save(mirror({ monthsAhead: 4 }));
        yield* mirrors.run();
        expect(writes(world.google)).toBe(before + 1);
        const revs = world.google
          .eventsOf(DEST)
          .map((event) => event.extendedProperties?.private?.[MIRROR_PROPERTY_KEY]?.split('.')[1]);
        expect(revs).toEqual([String(NOW + 1000), String(NOW)]);
      }),
    ),
  );

  it.effect('stands back from a calendar another mirror writes into', () =>
    scenario((world) =>
      Effect.gen(function* () {
        world.google.putEvent(WORK, meeting('a', NOW + 2 * HOUR));
        const mac = yield* makeDevice(world);
        const phone = yield* makeDevice(world);
        yield* mac(Effect.flatMap(Mirrors, (mirrors) => mirrors.save(mirror())));
        yield* mac(runMirrors());
        // Set up by hand on the phone: another id, so another mirror.
        yield* phone(sync);
        yield* phone(Effect.flatMap(Mirrors, (mirrors) => mirrors.save(mirror({ id: 'by-hand' }))));
        const before = writes(world.google);
        yield* phone(runMirrors());
        expect(writes(world.google)).toBe(before);
        expect(yield* phone(statusOf('by-hand'))).toEqual({
          reason: 'otherMirror',
          state: 'paused',
        });
      }),
    ),
  );

  it.effect('waits while a source holds an unsynced edit', () =>
    scenario((world) =>
      Effect.gen(function* () {
        world.google.putEvent(WORK, meeting('a', NOW + 2 * HOUR));
        // An edit that cannot land: Google refuses this calendar's writes.
        const mac = yield* makeDevice(world);
        const mirrors = yield* mac(Mirrors);
        yield* mirrors.save(mirror());
        yield* mirrors.run();
        yield* mac(
          Effect.gen(function* () {
            const events = yield* EventRepo;
            const row = yield* events.getById('acc-1', WORK, 'a');
            yield* events.upsertMany([
              { ...row!, syncStatus: 'pending', title: 'Edited here' } as never,
            ]);
            yield* updateMirrorLocal('mirror-1', (local) => local);
          }),
        );
        // A queued op for the source calendar is what the gate looks at.
        yield* mac(
          Effect.gen(function* () {
            const { PendingOpRepo } = yield* Effect.promise(() => import('@calendar/db'));
            const { PendingOp } = yield* Effect.promise(() => import('@calendar/core'));
            yield* (yield* PendingOpRepo).enqueue(
              new PendingOp({
                accountId: 'acc-1',
                attempts: 3,
                calendarId: WORK,
                createdAt: NOW,
                eventId: 'a',
                id: 'op-1',
                kind: 'update',
                nextAttemptAt: NOW + DAY,
              }),
            );
          }),
        );
        const before = writes(world.google);
        yield* mirrors.run({ force: true });
        expect(writes(world.google)).toBe(before);
        expect(yield* mac(statusOf())).toEqual({ reason: 'unsyncedChanges', state: 'waiting' });
      }),
    ),
  );

  it.effect('holds a large removal back, then believes it', () =>
    scenario((world) =>
      Effect.gen(function* () {
        for (let index = 0; index < 12; index++) {
          world.google.putEvent(WORK, meeting(`m${index}`, NOW + (index + 1) * HOUR));
        }
        const mac = yield* makeDevice(world);
        const mirrors = yield* mac(Mirrors);
        yield* mirrors.save(mirror());
        yield* mirrors.run();
        expect(world.google.eventsOf(DEST)).toHaveLength(12);

        for (let index = 0; index < 12; index++) {
          world.google.cancelEvent(WORK, `m${index}`);
        }
        yield* mac(sync);
        yield* mirrors.run();
        expect(world.google.eventsOf(DEST)).toHaveLength(12);
        expect(yield* mac(statusOf())).toEqual({ reason: 'largeRemoval', state: 'waiting' });

        // Still the same picture ten minutes later: it is real.
        yield* TestClock.adjust('11 minutes');
        yield* mac(sync);
        yield* mirrors.run();
        expect(world.google.eventsOf(DEST)).toHaveLength(0);
        expect(yield* mac(statusOf())).toEqual({ reason: undefined, state: 'upToDate' });
      }),
    ),
  );

  it.effect('stops when something keeps undoing the same copy', () =>
    scenario((world) =>
      Effect.gen(function* () {
        world.google.putEvent(WORK, meeting('a', NOW + 2 * HOUR));
        const mac = yield* makeDevice(world);
        const mirrors = yield* mac(Mirrors);
        yield* mirrors.save(mirror());
        yield* mirrors.run();
        const id = world.google.eventsOf(DEST)[0]!.id;
        for (let round = 0; round < 2; round++) {
          world.google.cancelEvent(DEST, id);
          yield* mac(sync);
          yield* mirrors.run();
        }
        // Written once, restored once; the third identical write is refused.
        expect(world.google.eventsOf(DEST)).toHaveLength(0);
        expect(yield* mac(statusOf())).toEqual({ reason: 'rewriteLoop', state: 'paused' });
        // Switching it on again is the user's all-clear.
        yield* mirrors.setEnabled('mirror-1', true);
        yield* mirrors.run();
        expect(world.google.eventsOf(DEST)).toHaveLength(1);
      }),
    ),
  );

  it.effect('mirrors reminders into an Apple calendar, done state included', () =>
    scenario((world) =>
      Effect.gen(function* () {
        const reminder = (title: string, extra: Record<string, unknown> = {}) =>
          world.reminders.client.create({
            listId: 'rem-household',
            reminder: { title, ...extra } as never,
          });
        const filter = yield* reminder('Clean the filter');
        yield* reminder('Pay the plumber', { dueDate: '2025-03-14' });
        const mac = yield* makeDevice(world);
        const mirrors = yield* mac(Mirrors);
        yield* mirrors.save(
          mirror({
            destination: { kind: 'apple', source: 'iCloud', title: 'Family' },
            sources: [{ kind: 'reminders', title: 'Household' }],
          }),
        );
        yield* mirrors.run();
        const family = () =>
          [...world.apple.state.series.values()]
            .map((series) => series.event)
            .filter((event) => event.calendarId === 'ek-family')
            .sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''));
        // The undated one sits on today; both are all-day and carry the marker.
        expect(family().map((event) => [event.title, event.startDate, event.isAllDay])).toEqual([
          ['Clean the filter', '2025-03-12', true],
          ['Pay the plumber', '2025-03-14', true],
        ]);
        expect(family().every((event) => parseMirrorUrl(event.url) !== undefined)).toBe(true);

        yield* world.reminders.client.setCompleted({ completed: true, id: filter.id });
        // The fake stamps the completion with the wall clock; the test clock
        // is where the mirror lives, so the stamp is moved onto it.
        const done = world.reminders.state.reminders.get(filter.id)!;
        world.reminders.state.reminders.set(filter.id, { ...done, completedAt: NOW + HOUR });
        yield* mac(sync);
        yield* mirrors.run();
        expect(family().find((event) => event.title.startsWith('✓'))).toMatchObject({
          startDate: '2025-03-12',
          title: '✓ Clean the filter',
        });
        const batches = world.apple.state.calls.filter((call) => call === 'applyBatch').length;
        yield* mirrors.run();
        expect(world.apple.state.calls.filter((call) => call === 'applyBatch')).toHaveLength(
          batches,
        );
      }),
    ),
  );

  it.effect('heals a raced duplicate in an Apple calendar and leaves an adopted one alone', () =>
    scenario((world) =>
      Effect.gen(function* () {
        world.google.putEvent(WORK, meeting('a', NOW + 2 * HOUR));
        world.google.putEvent(WORK, meeting('b', NOW + 4 * HOUR));
        const mac = yield* makeDevice(world);
        const mirrors = yield* mac(Mirrors);
        yield* mirrors.save(
          mirror({ destination: { kind: 'apple', source: 'iCloud', title: 'Family' } }),
        );
        yield* mirrors.run();
        const family = () =>
          [...world.apple.state.series.values()]
            .map((series) => series.event)
            .filter((event) => event.calendarId === 'ek-family');
        expect(family()).toHaveLength(2);
        const [first, second] = family();

        // Another device wrote the same copy before iCloud delivered this one…
        yield* world.apple.client.create({
          calendarId: 'ek-family',
          event: {
            endUtc: first!.endUtc,
            startUtc: first!.startUtc,
            timeZone: 'UTC',
            title: first!.title,
            url: first!.url!,
          },
        });
        // …and someone duplicated the other copy and made it their own.
        yield* world.apple.client.create({
          calendarId: 'ek-family',
          event: {
            endUtc: second!.endUtc,
            startUtc: second!.startUtc,
            timeZone: 'UTC',
            title: 'Our dinner',
            url: second!.url!,
          },
        });
        yield* mirrors.run({ force: true });
        const titles = family()
          .map((event) => event.title)
          .sort();
        expect(titles).toEqual(['Meeting a', 'Meeting b', 'Our dinner']);
        const dinner = family().find((event) => event.title === 'Our dinner');
        expect(dinner?.url).toBeUndefined();
      }),
    ),
  );

  it.effect('never treats another mirror’s copy as a source, and ignores local visibility', () =>
    scenario((world) =>
      Effect.gen(function* () {
        yield* world.apple.client.create({
          calendarId: 'ek-private',
          event: {
            endUtc: NOW + 3 * HOUR,
            startUtc: NOW + 2 * HOUR,
            timeZone: 'UTC',
            title: 'Dentist',
          },
        });
        yield* world.apple.client.create({
          calendarId: 'ek-private',
          event: {
            endUtc: NOW + 5 * HOUR,
            startUtc: NOW + 4 * HOUR,
            timeZone: 'UTC',
            title: 'A copy from elsewhere',
            url: encodeMirrorUrl({
              contentHash: '0123456789abcdef',
              keyHash: mirrorKeyHash('other', 'k'),
              rev: 1,
              tag: mirrorTag('other'),
            }),
          },
        });
        const mac = yield* makeDevice(world);
        // Hidden on this device: still a source.
        yield* mac(
          Effect.gen(function* () {
            const { CalendarRepo } = yield* Effect.promise(() => import('@calendar/db'));
            yield* (yield* CalendarRepo).setVisible(APPLE_CALENDAR_ACCOUNT_ID, 'ek-private', false);
          }),
        );
        const mirrors = yield* mac(Mirrors);
        yield* mirrors.save(
          mirror({ sources: [{ kind: 'apple', source: 'iCloud', title: 'Private' }] }),
        );
        yield* mirrors.run();
        expect(copies(world.google).map((copy) => copy.title)).toEqual(['Dentist']);
      }),
    ),
  );

  it.effect('previews what would be written and removes its copies when asked', () =>
    scenario((world) =>
      Effect.gen(function* () {
        world.google.putEvent(WORK, meeting('a', NOW + 2 * HOUR, { location: 'Room 4' }));
        world.google.putEvent(
          DEST,
          meeting('theirs', NOW + 3 * HOUR, { summary: 'Family dinner' }),
        );
        const mac = yield* makeDevice(world);
        const mirrors = yield* mac(Mirrors);
        const preview = yield* mirrors.preview(mirror());
        expect(preview).toMatchObject({
          copies: 1,
          otherEvents: 1,
          samples: [{ location: 'Room 4', title: 'Meeting a' }],
        });
        expect(writes(world.google)).toBe(0);
        const missing = yield* mirrors.preview(
          mirror({ sources: [{ kind: 'reminders', title: 'No such list' }] }),
        );
        expect(missing.blocked).toEqual({ detail: 'No such list', reason: 'sourceMissing' });

        yield* mirrors.save(mirror());
        yield* mirrors.run();
        expect(world.google.eventsOf(DEST)).toHaveLength(2);
        yield* mirrors.remove('mirror-1', true);
        // Only the mirror's own copy went.
        expect(copies(world.google).map((copy) => copy.title)).toEqual(['Family dinner']);
        expect(yield* mirrors.list()).toEqual([]);
        expect(yield* mac(readMirrorLocals)).toEqual({});
      }),
    ),
  );

  it.effect('creates a destination calendar in either provider', () =>
    scenario((world) =>
      Effect.gen(function* () {
        const mac = yield* makeDevice(world);
        const mirrors = yield* mac(Mirrors);
        const googleRef = yield* mirrors.createCalendar({
          accountId: 'acc-1',
          kind: 'google',
          title: 'Availability',
        });
        expect(googleRef).toMatchObject({
          email: 'nik@example.com',
          kind: 'google',
          title: 'Availability',
        });
        const appleRef = yield* mirrors.createCalendar({ kind: 'apple', title: 'For the family' });
        expect(appleRef).toEqual({ kind: 'apple', source: 'iCloud', title: 'For the family' });
        // Both resolve at once: the rows are there.
        const preview = yield* mirrors.preview(mirror({ destination: appleRef }));
        expect(preview.blocked).toBeUndefined();
      }),
    ),
  );
});
