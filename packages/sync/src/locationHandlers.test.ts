import {
  Account,
  CalendarInfo,
  DEVICE_ZONE,
  EventRecord,
  GeoLocation,
  HISTORY_REGION_RADIUS_METERS,
  TIME_ZONE_REGION_RADIUS_METERS,
} from '@calendar/core';
import {
  AccountRepo,
  CalendarRepo,
  EventRepo,
  LocationGeoRepo,
  reposLayer,
  runMigrations,
} from '@calendar/db';
import { makeFakeAppleCalendarClient } from '@calendar/apple-calendar';
import {
  GeoClient,
  type GeoClientShape,
  makeFakeGeoClient,
  unavailableGeoClient,
} from '@calendar/geo';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { describe } from 'vite-plus/test';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { writeTimeZoneSettings } from './deviceSettings.ts';
import {
  LOCATION_MISS_TTL_MS,
  LOCATION_REFRESH_AFTER_MS,
  locationHandlers,
  REGION_HINT_TTL_MS,
  regionHint,
} from './locationHandlers.ts';

const places = [
  {
    lat: 37.7823,
    lng: -122.4076,
    name: 'Blue Bottle Coffee',
    subtitle: '66 Mint St, San Francisco',
    title: 'Blue Bottle Coffee',
  },
];

const setup = (client: GeoClientShape) =>
  Layer.mergeAll(
    Layer.succeed(GeoClient, client),
    appleCalendarServicesLayer(makeFakeAppleCalendarClient().client).pipe(
      Layer.provideMerge(reposLayer),
      Layer.provideMerge(Layer.effectDiscard(runMigrations)),
      Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
      Layer.provideMerge(reactivityLayer),
    ),
  );

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const VIENNA = { lat: 48.2082, lng: 16.3738 };
const BERLIN = { lat: 52.52, lng: 13.405 };

/** An event with coordinates, `daysAgo` days back from the test clock's zero. */
const placedEvent = (id: string, daysAgo: number, at: { lat: number; lng: number }) =>
  new EventRecord({
    accountId: 'acc',
    calendarId: 'cal',
    endUtc: -daysAgo * DAY_MS + HOUR_MS,
    etag: `"${id}"`,
    geo: new GeoLocation({ ...at, source: id }),
    id,
    isAllDay: false,
    location: id,
    startTimeZone: 'UTC',
    startUtc: -daysAgo * DAY_MS,
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    title: id,
    updatedAt: 1,
  });

const seedPlaced = (events: ReadonlyArray<EventRecord>) =>
  Effect.gen(function* () {
    yield* (yield* AccountRepo).upsert(
      new Account({
        contactsEnabled: false,
        createdAt: 1,
        email: 'e2e@example.com',
        id: 'acc',
        provider: 'google',
        status: 'ok',
        tasksEnabled: false,
      }),
    );
    yield* (yield* CalendarRepo).upsertMany([
      new CalendarInfo({
        accessRole: 'owner',
        accountId: 'acc',
        colorHex: '#4285f4',
        id: 'cal',
        isPrimary: true,
        isVisible: true,
        provider: 'google',
        summary: 'Work',
        timeZone: 'UTC',
      }),
    ]);
    yield* (yield* EventRepo).upsertMany(events);
  });

describe('searchPlaces', () => {
  it.effect('returns suggestions for place text', () => {
    const { client, state } = makeFakeGeoClient({ places });
    return Effect.gen(function* () {
      expect(yield* locationHandlers.searchPlaces({ query: 'blue' })).toEqual([
        { subtitle: '66 Mint St, San Francisco', title: 'Blue Bottle Coffee' },
      ]);
      expect(state.calls).toEqual(['search:blue']);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('never asks MapKit about short text, URLs or meeting links', () => {
    const { client, state } = makeFakeGeoClient({ places });
    return Effect.gen(function* () {
      for (const query of ['bl', 'https://example.com', 'https://meet.google.com/abc-defg-hij']) {
        expect(yield* locationHandlers.searchPlaces({ query })).toEqual([]);
      }
      expect(state.calls).toEqual([]);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('degrades to no suggestions without a bridge', () =>
    Effect.gen(function* () {
      expect(yield* locationHandlers.searchPlaces({ query: 'blue bottle' })).toEqual([]);
    }).pipe(Effect.provide(setup(unavailableGeoClient('off')))),
  );
});

describe('resolveLocation', () => {
  const location = 'Blue Bottle Coffee, 66 Mint St, San Francisco';

  it.effect('resolves a picked suggestion with the location text as source', () => {
    const { client, state } = makeFakeGeoClient({ places });
    return Effect.gen(function* () {
      const geo = yield* locationHandlers.resolveLocation({
        location,
        suggestion: { subtitle: '66 Mint St, San Francisco', title: 'Blue Bottle Coffee' },
      });
      expect(geo).toEqual(
        new GeoLocation({
          lat: 37.7823,
          lng: -122.4076,
          name: 'Blue Bottle Coffee',
          source: location,
        }),
      );
      expect(state.calls).toEqual([`resolve:${location}`]);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('serves repeated free text from the cache', () => {
    const { client, state } = makeFakeGeoClient({ places });
    return Effect.gen(function* () {
      const first = yield* locationHandlers.resolveLocation({ location });
      const second = yield* locationHandlers.resolveLocation({
        location: 'blue bottle coffee,  66 Mint St, San Francisco',
      });
      expect(first?.lat).toBe(37.7823);
      // Same coordinates, but the source is always the caller's exact text.
      expect(second?.lat).toBe(37.7823);
      expect(second?.source).toBe('blue bottle coffee,  66 Mint St, San Francisco');
      expect(state.calls).toEqual([`resolve:${location}`]);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('caches a miss until it expires', () => {
    const { client, state } = makeFakeGeoClient({ places });
    return Effect.gen(function* () {
      expect(yield* locationHandlers.resolveLocation({ location: 'Atlantis' })).toBeNull();
      expect(yield* locationHandlers.resolveLocation({ location: 'Atlantis' })).toBeNull();
      expect(state.calls).toEqual(['resolve:Atlantis']);

      yield* TestClock.adjust(LOCATION_MISS_TTL_MS + 1);
      expect(yield* locationHandlers.resolveLocation({ location: 'Atlantis' })).toBeNull();
      expect(state.calls).toEqual(['resolve:Atlantis', 'resolve:Atlantis']);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('serves an old hit at once and refreshes it in the background', () => {
    const { client, state } = makeFakeGeoClient({ places });
    return Effect.gen(function* () {
      const first = yield* locationHandlers.resolveLocation({ location });
      expect(first?.lat).toBe(37.7823);

      // The place moved (or the text now names another one).
      state.places = [{ ...places[0]!, lat: 37.79 }];
      yield* TestClock.adjust(LOCATION_REFRESH_AFTER_MS + 1);
      const stale = yield* locationHandlers.resolveLocation({ location });
      expect(stale?.lat).toBe(37.7823);
      // Let the detached refresh run: it restamps the row with the new answer.
      yield* Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true });
      expect(state.calls).toEqual([`resolve:${location}`, `resolve:${location}`]);
      const fresh = yield* locationHandlers.resolveLocation({ location });
      expect(fresh?.lat).toBe(37.79);
      expect(state.calls).toHaveLength(2);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('clearLocationCache forgets every place', () => {
    const { client, state } = makeFakeGeoClient({ places });
    return Effect.gen(function* () {
      yield* locationHandlers.resolveLocation({ location });
      yield* locationHandlers.clearLocationCache(undefined);
      yield* locationHandlers.resolveLocation({ location });
      expect(state.calls).toEqual([`resolve:${location}`, `resolve:${location}`]);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('skips non-places without asking MapKit', () => {
    const { client, state } = makeFakeGeoClient({ places });
    return Effect.gen(function* () {
      expect(
        yield* locationHandlers.resolveLocation({ location: 'https://zoom.us/j/123456' }),
      ).toBeNull();
      expect(yield* locationHandlers.resolveLocation({ location: '  ' })).toBeNull();
      expect(state.calls).toEqual([]);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('caches nothing when there is no bridge', () =>
    Effect.gen(function* () {
      expect(yield* locationHandlers.resolveLocation({ location })).toBeNull();
      expect(
        yield* (yield* LocationGeoRepo).get('blue bottle coffee, 66 mint st, san francisco'),
      ).toBeNull();
    }).pipe(Effect.provide(setup(unavailableGeoClient('off')))),
  );
});

describe('mapSnapshot', () => {
  it.effect('clamps the requested size before calling the bridge', () => {
    const calls: Array<unknown> = [];
    const { client } = makeFakeGeoClient();
    const recording: GeoClientShape = {
      ...client,
      snapshot: (params) => {
        calls.push(params);
        return client.snapshot(params);
      },
    };
    return Effect.gen(function* () {
      const result = yield* locationHandlers.mapSnapshot({
        appearance: 'light',
        height: 99_999,
        lat: 1,
        lng: 2,
        scale: 9,
        width: 371.6,
      });
      expect(result.pngBase64.length).toBeGreaterThan(0);
      expect(calls).toEqual([
        { appearance: 'light', height: 1200, lat: 1, lng: 2, scale: 3, width: 372 },
      ]);
    }).pipe(Effect.provide(setup(recording)));
  });
});

describe('the resemblance gate', () => {
  // What a search answers for a text that names no such place.
  const junk = [
    { lat: 48.3, lng: 16.3, name: 'Am Rahm 4', subtitle: '3400 Weidling', title: 'Rahm 4' },
  ];
  const figlmuellers = [
    { lat: 48.21, lng: 16.37, name: 'Figl Bar', subtitle: 'Wien', title: 'Figl' },
    {
      lat: 48.209,
      lng: 16.375,
      name: 'Figlmüller Wollzeile',
      subtitle: 'Wollzeile 5, 1010 Wien',
      title: 'Figlmüller Wollzeile',
    },
    {
      lat: 48.2095,
      lng: 16.376,
      name: 'Figlmüller Bäckerstrasse',
      subtitle: 'Bäckerstraße 6, 1010 Wien',
      title: 'Figlmüller',
    },
  ];

  it.effect(
    'gives free text no pin for a match that does not resemble it, and caches the miss',
    () => {
      const { client, state } = makeFakeGeoClient({ places: junk });
      return Effect.gen(function* () {
        expect(yield* locationHandlers.resolveLocation({ location: 'Room 4' })).toBeNull();
        expect(yield* locationHandlers.resolveLocation({ location: 'Room 4' })).toBeNull();
        expect(state.calls).toEqual(['resolve:Room 4']);
        // A picked suggestion is that place, whatever it is called.
        expect(
          yield* locationHandlers.resolveLocation({
            location: 'Room 4',
            suggestion: { subtitle: '3400 Weidling', title: 'Rahm 4' },
          }),
        ).toMatchObject({ name: 'Am Rahm 4' });
      }).pipe(Effect.provide(setup(client)));
    },
  );

  it.effect('takes the first match that resembles the text as the pin', () => {
    const { client } = makeFakeGeoClient({ places: figlmuellers });
    return Effect.gen(function* () {
      expect(yield* locationHandlers.resolveLocation({ location: 'Figlmüller' })).toMatchObject({
        name: 'Figlmüller Wollzeile',
        source: 'Figlmüller',
      });
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect(
    'offers every match that resembles the text as a candidate, best first, uncached',
    () => {
      const { client, state } = makeFakeGeoClient({ places: figlmuellers });
      return Effect.gen(function* () {
        const candidates = yield* locationHandlers.placeCandidates({ location: 'Figlmüller' });
        expect(candidates.map((candidate) => candidate.geo.name)).toEqual([
          'Figlmüller Wollzeile',
          'Figlmüller Bäckerstrasse',
        ]);
        expect(candidates[0]).toMatchObject({ match: 'words', source: 'mapkit' });
        yield* locationHandlers.placeCandidates({ location: 'Figlmüller' });
        expect(state.calls).toEqual(['resolve:Figlmüller', 'resolve:Figlmüller']);
        expect(
          yield* locationHandlers.placeCandidates({ location: 'https://zoom.us/j/1' }),
        ).toEqual([]);
      }).pipe(Effect.provide(setup(client)));
    },
  );

  it.effect('has no candidates without a bridge', () =>
    Effect.gen(function* () {
      expect(yield* locationHandlers.placeCandidates({ location: 'Figlmüller' })).toEqual([]);
    }).pipe(Effect.provide(setup(unavailableGeoClient('off')))),
  );
});

describe('regionHint', () => {
  it.effect(
    'looks around the densest cluster of recent events, the latest first among equals',
    () => {
      const { client, state } = makeFakeGeoClient({ places });
      return Effect.gen(function* () {
        yield* seedPlaced([
          placedEvent('berlin', 3, BERLIN),
          placedEvent('vienna-1', 10, VIENNA),
          placedEvent('vienna-2', 20, { lat: 48.21, lng: 16.4 }),
          // Beyond the window: does not count.
          placedEvent('old', 120, { lat: 0, lng: 0 }),
        ]);
        const region = yield* regionHint;
        expect(region?.radiusMeters).toBe(HISTORY_REGION_RADIUS_METERS);
        expect(region?.lat).toBeCloseTo((VIENNA.lat + 48.21) / 2, 4);
        // Both lookups carry it.
        yield* locationHandlers.searchPlaces({ query: 'Blue Bottle' });
        yield* locationHandlers.resolveLocation({ location: 'Blue Bottle Coffee' });
        expect(state.regions.map((hint) => hint?.radiusMeters)).toEqual([
          HISTORY_REGION_RADIUS_METERS,
          HISTORY_REGION_RADIUS_METERS,
        ]);
        // A picked suggestion needs no hint.
        yield* locationHandlers.resolveLocation({
          location: 'Blue Bottle Coffee',
          suggestion: { subtitle: '66 Mint St, San Francisco', title: 'Blue Bottle Coffee' },
        });
        expect(state.regions.at(-1)).toBeUndefined();
      }).pipe(Effect.provide(setup(client)));
    },
  );

  it.effect('counts the occurrences that were, not a series once or a future override', () => {
    // Review: a daily Vienna series with tomorrow's Berlin override chose Berlin.
    const { client } = makeFakeGeoClient({ places });
    return Effect.gen(function* () {
      const series = placedEvent('series', 30, VIENNA);
      yield* seedPlaced([
        new EventRecord({ ...series, recurrence: ['RRULE:FREQ=DAILY'] }),
        new EventRecord({
          ...placedEvent('series_tomorrow', -1, BERLIN),
          originalStartUtc: DAY_MS,
          recurringEventId: 'series',
        }),
        new EventRecord({ ...placedEvent('gone', 2, BERLIN), status: 'cancelled' }),
      ]);
      const region = yield* regionHint;
      expect(region?.lat).toBeCloseTo(VIENNA.lat, 3);
      expect(region?.lng).toBeCloseTo(VIENNA.lng, 3);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('reuses the hint for a while, then reads the events again', () => {
    // Review: every keystroke read a quarter's events and clustered them.
    const { client } = makeFakeGeoClient({ places });
    return Effect.gen(function* () {
      yield* seedPlaced([placedEvent('vienna', 1, VIENNA)]);
      expect((yield* regionHint)?.lat).toBeCloseTo(VIENNA.lat, 3);
      yield* (yield* EventRepo).upsertMany([
        placedEvent('berlin-1', 0, BERLIN),
        placedEvent('berlin-2', 0, { lat: 52.5, lng: 13.4 }),
      ]);
      expect((yield* regionHint)?.lat).toBeCloseTo(VIENNA.lat, 3);
      yield* TestClock.adjust(REGION_HINT_TTL_MS + 1);
      expect((yield* regionHint)?.lat).toBeCloseTo(BERLIN.lat, 1);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('falls back to the primary time zone’s city, else to no hint', () => {
    const { client } = makeFakeGeoClient({ places });
    return Effect.gen(function* () {
      yield* writeTimeZoneSettings({
        primary: 'Europe/Vienna',
        zones: [DEVICE_ZONE, 'Europe/Vienna'],
      });
      expect(yield* regionHint).toEqual({
        ...VIENNA,
        radiusMeters: TIME_ZONE_REGION_RADIUS_METERS,
      });
      yield* writeTimeZoneSettings({ primary: 'Etc/UTC', zones: [DEVICE_ZONE, 'Etc/UTC'] });
      // The hint is reused for a while: the new zone counts once it expires.
      yield* TestClock.adjust(REGION_HINT_TTL_MS + 1);
      expect(yield* regionHint).toBeUndefined();
    }).pipe(Effect.provide(setup(client)));
  });
});
