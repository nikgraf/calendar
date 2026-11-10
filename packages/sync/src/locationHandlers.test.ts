import {
  Account,
  CalendarInfo,
  DEVICE_ZONE,
  EventRecord,
  GeoLocation,
  HISTORY_REGION_RADIUS_METERS,
  type PlaceSuggestion,
  preselectedPlace,
  TIME_ZONE_NEAR_METERS,
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
  FAKE_MAP_PNG_BASE64,
  GeoClient,
  type GeoClientShape,
  type GeoPlaceJson,
  GeoRequestError,
  makeFakeGeoClient,
  unavailableGeoClient,
} from '@calendar/geo';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { describe } from 'vite-plus/test';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { writeTimeZoneSettings } from './deviceSettings.ts';
import {
  CANDIDATE_SEARCH_TIMEOUT,
  FILL_IN_LIMIT,
  FILL_IN_WINDOW_MS,
  LOCATION_MISS_TTL_MS,
  LOCATION_REFRESH_AFTER_MS,
  locationHandlers,
  REGION_HINT_TTL_MS,
  regionHint,
  TYPEAHEAD_SEARCH_TIMEOUT,
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

/**
 * No zone the region table knows, so no test leans on where the machine
 * is: without a region every place is nearby. The tests about near and
 * far seed events with coordinates or write a zone of their own.
 */
const NO_REGION_ZONE = { primary: 'Etc/UTC', zones: [DEVICE_ZONE, 'Etc/UTC'] };

const setup = (client: GeoClientShape) =>
  Layer.mergeAll(
    Layer.succeed(GeoClient, client),
    Layer.effectDiscard(writeTimeZoneSettings(NO_REGION_ZONE)).pipe(
      Layer.provideMerge(
        appleCalendarServicesLayer(makeFakeAppleCalendarClient().client).pipe(
          Layer.provideMerge(reposLayer),
          Layer.provideMerge(Layer.effectDiscard(runMigrations)),
          Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
          Layer.provideMerge(reactivityLayer),
        ),
      ),
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
      // One row, fewer than asked for: the search is asked too, and the
      // place both know is listed once, with the coordinates it came with.
      expect(yield* locationHandlers.searchPlaces({ query: 'blue' })).toEqual([
        {
          coordinates: { lat: 37.7823, lng: -122.4076 },
          subtitle: '66 Mint St, San Francisco',
          title: 'Blue Bottle Coffee',
        },
      ]);
      expect(state.calls).toEqual(['search:blue', 'resolve:blue']);
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
    // Streets apart from the Wollzeile one: nearer than 100 m they would be one place.
    {
      lat: 48.212,
      lng: 16.379,
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
    'offers the hits that resemble the text first, then the rest, each once, uncached',
    () => {
      const { client, state } = makeFakeGeoClient({ places: figlmuellers });
      return Effect.gen(function* () {
        const candidates = yield* locationHandlers.placeCandidates({ location: 'Figlmüller' });
        // The search and the completer both answer the Figlmüllers: listed once.
        expect(candidates.map((candidate) => [candidate.geo.name, candidate.match])).toEqual([
          ['Figlmüller Wollzeile', 'words'],
          ['Figlmüller Bäckerstrasse', 'words'],
          ['Figl Bar', 'search'],
        ]);
        // A pick writes the name and address, as a picked typeahead row would.
        expect(candidates[0]).toMatchObject({
          address: 'Wollzeile 5, 1010 Wien',
          geo: { source: 'Figlmüller Wollzeile, Wollzeile 5, 1010 Wien' },
          source: 'mapkit',
        });
        yield* locationHandlers.placeCandidates({ location: 'Figlmüller' });
        expect(state.calls.filter((call) => call === 'resolve:Figlmüller')).toHaveLength(2);
        expect(
          yield* locationHandlers.placeCandidates({ location: 'https://zoom.us/j/1' }),
        ).toEqual([]);
      }).pipe(Effect.provide(setup(client)));
    },
  );

  it.effect('finds a branch only the completer knows, resolved to its place', () => {
    const { client } = makeFakeGeoClient({ places: figlmuellers });
    return Effect.gen(function* () {
      // The search reads nothing in "Wollzeile" (no title is in it); the completer's row is.
      const candidates = yield* locationHandlers.placeCandidates({ location: 'Wollzeile' });
      expect(candidates.map((c) => [c.geo.name, c.match])).toEqual([
        ['Figlmüller Wollzeile', 'words'],
      ]);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('keeps the completer rows that resolved when one of them stalls', () => {
    // Review: one stalled row timed the whole batch out, finished rows included.
    // The budget stays one: the rows resolve within the completer's
    // 3 s, so the hook's 5 s (`placesOf`) is never passed.
    const base = makeFakeGeoClient({ places: figlmuellers }).client;
    const oneStalls: GeoClientShape = {
      ...base,
      resolve: (params) =>
        params.suggestion === undefined
          ? Effect.succeed([])
          : params.suggestion.title === 'Figlmüller'
            ? Effect.never
            : base.resolve(params),
    };
    return Effect.gen(function* () {
      const asked = yield* Effect.forkChild(
        locationHandlers.placeCandidates({ location: 'Figlmüller' }),
      );
      yield* TestClock.adjust(CANDIDATE_SEARCH_TIMEOUT);
      const candidates = yield* Fiber.join(asked);
      expect(candidates.map((c) => c.geo.name)).toEqual(['Figlmüller Wollzeile']);
    }).pipe(Effect.provide(setup(oneStalls)));
  });

  it.effect('keeps what the search answered when the completer stalls', () => {
    // Review: one timeout over both ways threw the finished answer away too.
    const stalledRows: GeoClientShape = {
      ...makeFakeGeoClient({ places: figlmuellers }).client,
      search: () => Effect.never,
    };
    return Effect.gen(function* () {
      const asked = yield* Effect.forkChild(
        locationHandlers.placeCandidates({ location: 'Figlmüller' }),
      );
      yield* TestClock.adjust(CANDIDATE_SEARCH_TIMEOUT);
      const candidates = yield* Fiber.join(asked);
      expect(candidates.map((c) => c.geo.name)).toEqual([
        'Figlmüller Wollzeile',
        'Figlmüller Bäckerstrasse',
        'Figl Bar',
      ]);
    }).pipe(Effect.provide(setup(stalledRows)));
  });

  it.effect('reads the past places once for a while, then again', () => {
    // Review: a year of occurrences was expanded on every turn.
    const { client } = makeFakeGeoClient({ places });
    return Effect.gen(function* () {
      expect(yield* locationHandlers.placeCandidates({ location: 'Café Central' })).toEqual([]);
      yield* seedPlaced([
        new EventRecord({
          ...placedEvent('coffee', 20, { lat: 48.21, lng: 16.365 }),
          geo: new GeoLocation({
            lat: 48.21,
            lng: 16.365,
            name: 'Café Central',
            source: 'Café Central',
          }),
          location: 'Café Central',
        }),
      ]);
      expect(yield* locationHandlers.placeCandidates({ location: 'Café Central' })).toEqual([]);
      yield* TestClock.adjust(REGION_HINT_TTL_MS + 1);
      expect(
        (yield* locationHandlers.placeCandidates({ location: 'Café Central' })).map(
          (c) => c.source,
        ),
      ).toEqual(['history']);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('answers the past places alone when the search stalls', () => {
    // Review: a stalled MapKit request held the whole draft, title and times too.
    const stalled: GeoClientShape = {
      ...makeFakeGeoClient({ places }).client,
      resolve: () => Effect.never,
    };
    return Effect.gen(function* () {
      yield* seedPlaced([
        new EventRecord({
          ...placedEvent('coffee', 20, { lat: 48.21, lng: 16.365 }),
          geo: new GeoLocation({
            lat: 48.21,
            lng: 16.365,
            name: 'Café Central',
            source: 'Café Central',
          }),
          location: 'Café Central',
        }),
      ]);
      const asked = yield* Effect.forkChild(
        locationHandlers.placeCandidates({ location: 'Café Central' }),
      );
      yield* TestClock.adjust(CANDIDATE_SEARCH_TIMEOUT);
      const candidates = yield* Fiber.join(asked);
      expect(candidates.map((c) => [c.source, c.geo.source])).toEqual([
        ['history', 'Café Central'],
      ]);
    }).pipe(Effect.provide(setup(stalled)));
  });

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
        // Every lookup carries it: the typeahead's two (the completer,
        // then the search that fills in) and the pin's.
        yield* locationHandlers.searchPlaces({ query: 'Blue Bottle' });
        yield* locationHandlers.resolveLocation({ location: 'Blue Bottle Coffee' });
        expect(state.regions.map((hint) => hint?.radiusMeters)).toEqual([
          HISTORY_REGION_RADIUS_METERS,
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
        near: { meters: TIME_ZONE_NEAR_METERS, points: [VIENNA] },
        radiusMeters: TIME_ZONE_REGION_RADIUS_METERS,
      });
      yield* writeTimeZoneSettings({ primary: 'Etc/UTC', zones: [DEVICE_ZONE, 'Etc/UTC'] });
      // The hint is reused for a while: the new zone counts once it expires.
      yield* TestClock.adjust(REGION_HINT_TTL_MS + 1);
      expect(yield* regionHint).toBeUndefined();
    }).pipe(Effect.provide(setup(client)));
  });
});

/** MapKit as given: what its search finds for a text, and the completer's rows. */
const mapkit = ({
  found = {},
  rows = {},
}: {
  readonly found?: Readonly<Record<string, ReadonlyArray<GeoPlaceJson>>>;
  readonly rows?: Readonly<Record<string, ReadonlyArray<PlaceSuggestion>>>;
}) => {
  const calls: Array<string> = [];
  const client: GeoClientShape = {
    resolve: ({ query, suggestion }) =>
      Effect.sync(() => {
        calls.push(`resolve:${query}`);
        return suggestion === undefined ? (found[query] ?? []) : [];
      }),
    search: ({ query }) =>
      Effect.sync(() => {
        calls.push(`search:${query}`);
        return rows[query] ?? [];
      }),
    snapshot: () => Effect.succeed(FAKE_MAP_PNG_BASE64),
  };
  return { calls, client };
};

describe('nearby first', () => {
  // Observed 2026-11-06, the user's events in Vienna: "Cafe Meek" (Kaffemik,
  // as dictation heard it) took a café in South Africa, "Vienna, Austria"
  // the latest past place in Vienna, and a typed "kaffeemik" offered only
  // a namesake in Berlin.
  const kaffemik = {
    address: 'Zollergasse 5, 1070 Vienna, Austria',
    lat: 48.2003,
    lng: 16.3497,
    name: 'Kaffemik',
  };
  const benoni = {
    address: '9 10th Avenue, Benoni, Gauteng, 1501, South Africa',
    lat: -26.1885,
    lng: 28.3208,
    name: 'Meek Café',
  };
  const london = {
    address: '77 Heath Street, London, NW3 6UG, England',
    lat: 51.5586,
    lng: -0.1787,
    name: 'Meekhun Thai bistro',
  };
  const adlon = {
    address: 'Unter den Linden 77, 10117 Berlin, Germany',
    lat: 52.5159,
    lng: 13.3806,
    name: 'Hotel Adlon Kempinski Berlin',
  };
  const city = { address: 'Vienna, Austria', lat: 48.2082, lng: 16.3738, name: 'Vienna' };
  const berlinRow = {
    subtitle: 'Erich-Baron-Weg 83, Mahlsdorf, 12623 Berlin, Germany',
    title: 'kaffeemike',
  };
  const kaffemikRow = {
    coordinates: { lat: 48.2003, lng: 16.3497 },
    subtitle: 'Zollergasse 5, 1070 Vienna, Austria',
    title: 'Kaffemik',
  };

  /** The user's events are in Vienna: what is nearby is known. */
  const inVienna = seedPlaced([placedEvent('home', 1, VIENNA), placedEvent('work', 2, VIENNA)]);

  it.effect('takes no namesake on another continent for a draft, and offers it', () => {
    const { client } = mapkit({ found: { 'Cafe Meek': [benoni, london] } });
    return Effect.gen(function* () {
      yield* inVienna;
      const candidates = yield* locationHandlers.placeCandidates({ location: 'Cafe Meek' });
      expect(candidates.map((c) => [c.geo.name, c.match])).toEqual([['Meek Café', 'search']]);
      expect(preselectedPlace(candidates)).toBeUndefined();
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('takes the nearby place a dictated name sounds like, before a far namesake', () => {
    const { client } = mapkit({ found: { 'Cafe Meek': [benoni, kaffemik] } });
    return Effect.gen(function* () {
      yield* inVienna;
      const candidates = yield* locationHandlers.placeCandidates({ location: 'Cafe Meek' });
      expect(candidates.map((c) => [c.geo.name, c.match])).toEqual([
        ['Kaffemik', 'phonetic'],
        ['Meek Café', 'search'],
      ]);
      expect(preselectedPlace(candidates)?.geo.source).toBe(
        'Kaffemik, Zollergasse 5, 1070 Vienna, Austria',
      );
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('finds a place the user has been to by how a dictated name sounds', () => {
    const { client } = mapkit({ found: { 'Cafe Meek': [benoni] } });
    return Effect.gen(function* () {
      yield* seedPlaced([
        placedEvent('home', 1, VIENNA),
        new EventRecord({
          ...placedEvent('coffee', 30, kaffemik),
          geo: new GeoLocation({
            lat: kaffemik.lat,
            lng: kaffemik.lng,
            name: 'Kaffemik',
            source: 'Kaffemik, Zollergasse 5, 1070 Vienna, Austria',
          }),
          location: 'Kaffemik, Zollergasse 5, 1070 Vienna, Austria',
        }),
      ]);
      const candidates = yield* locationHandlers.placeCandidates({ location: 'Cafe Meek' });
      expect(candidates.map((c) => [c.source, c.geo.name, c.match])).toEqual([
        ['history', 'Kaffemik', 'phonetic'],
        ['mapkit', 'Meek Café', 'search'],
      ]);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('takes a far place when the text says where it is', () => {
    const { client } = mapkit({
      found: { 'Hotel Adlon': [adlon], 'Hotel Adlon Berlin': [adlon] },
    });
    return Effect.gen(function* () {
      yield* inVienna;
      const named = yield* locationHandlers.placeCandidates({ location: 'Hotel Adlon Berlin' });
      expect(named.map((c) => c.match)).toEqual(['words']);
      const bare = yield* locationHandlers.placeCandidates({ location: 'Hotel Adlon' });
      expect(bare.map((c) => c.match)).toEqual(['search']);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('takes a city for the city, not for the latest past place in it', () => {
    const { client } = mapkit({ found: { 'Vienna, Austria': [city] } });
    return Effect.gen(function* () {
      yield* seedPlaced([
        new EventRecord({
          ...placedEvent('yard', 3, { lat: 48.23, lng: 16.31 }),
          geo: new GeoLocation({
            lat: 48.23,
            lng: 16.31,
            name: 'Mistplatz Hernals',
            source: 'Mistplatz Hernals, Richthausenstraße 2, 1170 Vienna, Austria',
          }),
          location: 'Mistplatz Hernals, Richthausenstraße 2, 1170 Vienna, Austria',
        }),
      ]);
      const candidates = yield* locationHandlers.placeCandidates({ location: 'Vienna, Austria' });
      expect(candidates.map((c) => [c.source, c.geo.name, c.match])).toEqual([
        ['mapkit', 'Vienna', 'words'],
      ]);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('gives free text no pin on another continent, and one where the text says', () => {
    const { calls, client } = mapkit({
      found: { 'Cafe Meek': [benoni], 'Hotel Adlon Berlin': [adlon] },
    });
    return Effect.gen(function* () {
      yield* inVienna;
      expect(yield* locationHandlers.resolveLocation({ location: 'Cafe Meek' })).toBeNull();
      // Review: a place too far is a "no" for where the user is now, not
      // "no such place" for three days: asked again, never cached.
      expect(yield* locationHandlers.resolveLocation({ location: 'Cafe Meek' })).toBeNull();
      expect(calls).toEqual(['resolve:Cafe Meek', 'resolve:Cafe Meek']);
      expect(
        yield* locationHandlers.resolveLocation({ location: 'Hotel Adlon Berlin' }),
      ).toMatchObject({ lat: adlon.lat, name: 'Hotel Adlon Kempinski Berlin' });
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('keeps home near when only a trip’s events have a place', () => {
    // Review: three placed events in Lisbon and none at home made Vienna far.
    const figlmueller = {
      address: 'Wollzeile 5, 1010 Vienna, Austria',
      lat: 48.209,
      lng: 16.375,
      name: 'Figlmüller',
    };
    const { client } = mapkit({ found: { Figlmüller: [figlmueller] } });
    const lisbon = { lat: 38.7223, lng: -9.1393 };
    return Effect.gen(function* () {
      yield* writeTimeZoneSettings({
        primary: 'Europe/Vienna',
        zones: [DEVICE_ZONE, 'Europe/Vienna'],
      });
      yield* seedPlaced([
        placedEvent('trip-1', 1, lisbon),
        placedEvent('trip-2', 2, lisbon),
        placedEvent('trip-3', 3, lisbon),
      ]);
      expect(yield* locationHandlers.resolveLocation({ location: 'Figlmüller' })).toMatchObject({
        name: 'Figlmüller',
      });
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('lets a stale pin the rule now refuses give way to a miss', () => {
    // Review: a cached far hit was served on, and every read searched again.
    const { calls, client } = mapkit({ found: { 'Cafe Meek': [benoni] } });
    return Effect.gen(function* () {
      yield* inVienna;
      const cache = yield* LocationGeoRepo;
      const old = new GeoLocation({
        lat: benoni.lat,
        lng: benoni.lng,
        name: benoni.name,
        source: 'Cafe Meek',
      });
      yield* cache.set('cafe meek', old, 0);
      yield* TestClock.adjust(LOCATION_REFRESH_AFTER_MS + 1);
      // Served once more while the refresh runs.
      expect(yield* locationHandlers.resolveLocation({ location: 'Cafe Meek' })).toMatchObject({
        name: 'Meek Café',
      });
      yield* Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true });
      expect(yield* locationHandlers.resolveLocation({ location: 'Cafe Meek' })).toBeNull();
      expect(calls).toEqual(['resolve:Cafe Meek']);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('counts only another part of the world as far when a zone is all it knows', () => {
    const { client } = mapkit({ found: { 'Cafe Meek': [benoni], 'Hotel Adlon': [adlon] } });
    return Effect.gen(function* () {
      yield* writeTimeZoneSettings({
        primary: 'Europe/Vienna',
        zones: [DEVICE_ZONE, 'Europe/Vienna'],
      });
      expect(yield* locationHandlers.resolveLocation({ location: 'Cafe Meek' })).toBeNull();
      // The zone's city is not where the user is: Berlin may be home.
      expect(yield* locationHandlers.resolveLocation({ location: 'Hotel Adlon' })).toMatchObject({
        lat: adlon.lat,
      });
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('fills the typeahead in with the nearby place a misspelled name means', () => {
    const { calls, client } = mapkit({
      found: { kaffeemik: [kaffemik] },
      rows: { kaffeemik: [berlinRow] },
    });
    return Effect.gen(function* () {
      yield* inVienna;
      expect(yield* locationHandlers.searchPlaces({ query: 'kaffeemik' })).toEqual([
        kaffemikRow,
        berlinRow,
      ]);
      expect(calls).toEqual(['search:kaffeemik', 'resolve:kaffeemik']);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('adds nothing the text does not name, and nothing far away', () => {
    const street = {
      address: 'Kaffeeweg, 1140 Vienna, Austria',
      lat: 48.21,
      lng: 16.26,
      name: 'Kaffeeweg',
    };
    const { client } = mapkit({
      found: { 'cafe meek': [benoni], kaffeemi: [street] },
      rows: { 'cafe meek': [], kaffeemi: [berlinRow] },
    });
    return Effect.gen(function* () {
      yield* inVienna;
      expect(yield* locationHandlers.searchPlaces({ query: 'kaffeemi' })).toEqual([berlinRow]);
      expect(yield* locationHandlers.searchPlaces({ query: 'cafe meek' })).toEqual([]);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('remembers a miss that nothing resembles', () => {
    const { calls, client } = mapkit({ found: { 'Room 9': [london] } });
    return Effect.gen(function* () {
      yield* inVienna;
      expect(yield* locationHandlers.resolveLocation({ location: 'Room 9' })).toBeNull();
      expect(yield* locationHandlers.resolveLocation({ location: 'Room 9' })).toBeNull();
      expect(calls).toEqual(['resolve:Room 9']);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('gives a place said only by its kind the user’s own, never a namesake', () => {
    // MapKit's answer to "office" in Vienna (probe, 2026-11-09), and to "gym".
    const offices = {
      address: 'Bösendorferstraße 12, 1010 Vienna, Austria',
      lat: 48.2005,
      lng: 16.3722,
      name: 'The Vienna Philharmonic - Administrative Offices',
    };
    const { calls, client } = mapkit({ found: { home: [offices], office: [offices] } });
    return Effect.gen(function* () {
      yield* inVienna;
      // No pin, and a miss to remember: no later region makes it one.
      expect(yield* locationHandlers.resolveLocation({ location: 'office' })).toBeNull();
      expect(yield* locationHandlers.resolveLocation({ location: 'office' })).toBeNull();
      expect(calls).toEqual(['resolve:office']);
      const candidates = yield* locationHandlers.placeCandidates({ location: 'office' });
      expect(candidates.map((c) => [c.geo.name, c.match])).toEqual([
        ['The Vienna Philharmonic - Administrative Offices', 'search'],
      ]);
      expect(preselectedPlace(candidates)).toBeUndefined();
      // A past event written "home" is the user's home.
      const own = yield* locationHandlers.placeCandidates({ location: 'home' });
      expect(preselectedPlace(own)).toMatchObject({ geo: { source: 'home' }, source: 'history' });
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('remembers no miss for a place that is only too far, whatever names it', () => {
    // Review (Codex): a far bar called exactly "The Office", and a far
    // venue named past its lead, were cached as "no such place".
    const bar = {
      address: '12 Main St, Portland, OR, United States',
      lat: 45.52,
      lng: -122.68,
      name: 'The Office',
    };
    const figlmueller = {
      address: 'Hauptstraße 1, 10115 Berlin, Germany',
      lat: 52.53,
      lng: 13.38,
      name: 'Figlmüller',
    };
    const { calls, client } = mapkit({
      found: { 'im Figlmüller': [figlmueller], 'The Office': [bar] },
    });
    return Effect.gen(function* () {
      yield* inVienna;
      expect(yield* locationHandlers.resolveLocation({ location: 'The Office' })).toBeNull();
      expect(yield* locationHandlers.resolveLocation({ location: 'The Office' })).toBeNull();
      expect(yield* locationHandlers.resolveLocation({ location: 'im Figlmüller' })).toBeNull();
      expect(yield* locationHandlers.resolveLocation({ location: 'im Figlmüller' })).toBeNull();
      expect(calls).toEqual([
        'resolve:The Office',
        'resolve:The Office',
        'resolve:im Figlmüller',
        'resolve:im Figlmüller',
      ]);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('takes a city said on its own, however far', () => {
    // Review: "Berlin", said in Vienna, got no pin.
    const berlinCity = { address: 'Berlin, Germany', lat: 52.52, lng: 13.405, name: 'Berlin' };
    const { client } = mapkit({ found: { Berlin: [berlinCity] } });
    return Effect.gen(function* () {
      yield* inVienna;
      expect(yield* locationHandlers.resolveLocation({ location: 'Berlin' })).toMatchObject({
        name: 'Berlin',
      });
      const candidates = yield* locationHandlers.placeCandidates({ location: 'Berlin' });
      expect(preselectedPlace(candidates)?.geo.name).toBe('Berlin');
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('asks the search only where the completer runs short', () => {
    const full = Array.from({ length: 6 }, (_, index) => ({ title: `Kaffee ${String(index)}` }));
    const { calls, client } = mapkit({
      found: { kaffee: [kaffemik] },
      rows: { kaffee: full },
    });
    return Effect.gen(function* () {
      expect(yield* locationHandlers.searchPlaces({ query: 'kaffee' })).toEqual(full);
      expect(calls).toEqual(['search:kaffee']);
      // A caller that wants fewer rows has enough sooner.
      expect(yield* locationHandlers.searchPlaces({ limit: 3, query: 'kaffee' })).toHaveLength(6);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('answers with the completer’s rows when the search stalls or fails', () => {
    const base = mapkit({ rows: { kaffeemik: [berlinRow] } }).client;
    const stalled: GeoClientShape = { ...base, resolve: () => Effect.never };
    const failing: GeoClientShape = {
      ...base,
      resolve: () =>
        Effect.fail(new GeoRequestError({ message: 'throttled', method: 'geo.resolve' })),
    };
    return Effect.gen(function* () {
      const asked = yield* Effect.forkChild(locationHandlers.searchPlaces({ query: 'kaffeemik' }));
      yield* TestClock.adjust(TYPEAHEAD_SEARCH_TIMEOUT);
      expect(yield* Fiber.join(asked)).toEqual([berlinRow]);
      expect(
        yield* locationHandlers
          .searchPlaces({ query: 'kaffeemik' })
          .pipe(Effect.provideService(GeoClient, failing)),
      ).toEqual([berlinRow]);
    }).pipe(Effect.provide(setup(stalled)));
  });

  it.effect('searches for the latest text only: an overtaken keystroke spends nothing', () => {
    // The completer answers a query it dropped for a newer one with no rows:
    // every overtaken keystroke would have asked the search for its old text.
    const { calls, client } = mapkit({
      found: { kaffeemik: [kaffemik] },
      rows: { kaffeemik: [berlinRow] },
    });
    return Effect.gen(function* () {
      yield* inVienna;
      const asked = yield* Deferred.make<void>();
      const dropped = yield* Deferred.make<void>();
      const typing: GeoClientShape = {
        ...client,
        search: (params) =>
          params.query === 'kaffeemi'
            ? Deferred.succeed(asked, undefined).pipe(
                Effect.andThen(Deferred.await(dropped)),
                Effect.as([]),
              )
            : client.search(params),
      };
      const places = (query: string) =>
        locationHandlers.searchPlaces({ query }).pipe(Effect.provideService(GeoClient, typing));
      const overtaken = yield* Effect.forkChild(places('kaffeemi'));
      yield* Deferred.await(asked);
      expect(yield* places('kaffeemik')).toEqual([kaffemikRow, berlinRow]);
      yield* Deferred.succeed(dropped, undefined);
      expect(yield* Fiber.join(overtaken)).toEqual([]);
      expect(calls).toEqual(['search:kaffeemik', 'resolve:kaffeemik']);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('stops filling in before MapKit would throttle, and starts again a minute on', () => {
    const { calls, client } = mapkit({});
    const searches = () => calls.filter((call) => call.startsWith('resolve:')).length;
    return Effect.gen(function* () {
      for (let typed = 0; typed <= FILL_IN_LIMIT + 2; typed += 1) {
        yield* locationHandlers.searchPlaces({ query: `kaffee ${String(typed)}` });
      }
      expect(searches()).toBe(FILL_IN_LIMIT);
      yield* TestClock.adjust(FILL_IN_WINDOW_MS);
      yield* locationHandlers.searchPlaces({ query: 'kaffeemik' });
      expect(searches()).toBe(FILL_IN_LIMIT + 1);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('asks no search when the completer already has the text itself', () => {
    const { calls, client } = mapkit({
      found: { kaffemik: [kaffemik] },
      rows: { kaffemik: [{ subtitle: 'Zollergasse 5, 1070 Vienna, Austria', title: 'Kaffemik' }] },
    });
    return Effect.gen(function* () {
      expect(yield* locationHandlers.searchPlaces({ query: 'kaffemik' })).toHaveLength(1);
      expect(calls).toEqual(['search:kaffemik']);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect('asks no search when the completer itself failed', () => {
    const { calls, client } = mapkit({ found: { kaffeemik: [kaffemik] } });
    const broken: GeoClientShape = {
      ...client,
      search: ({ query }) => {
        calls.push(`search:${query}`);
        return Effect.fail(new GeoRequestError({ message: 'offline', method: 'geo.search' }));
      },
    };
    return Effect.gen(function* () {
      expect(yield* locationHandlers.searchPlaces({ query: 'kaffeemik' })).toEqual([]);
      expect(calls).toEqual(['search:kaffeemik']);
    }).pipe(Effect.provide(setup(broken)));
  });

  it.effect('takes a picked row the search found as that place, with nothing to look up', () => {
    const { calls, client } = mapkit({});
    const location = 'Kaffemik, Zollergasse 5, 1070 Vienna, Austria';
    return Effect.gen(function* () {
      const picked = yield* locationHandlers.resolveLocation({ location, suggestion: kaffemikRow });
      expect(picked).toEqual(
        new GeoLocation({ lat: 48.2003, lng: 16.3497, name: 'Kaffemik', source: location }),
      );
      expect(calls).toEqual([]);
      // Kept like any resolved place: the editor reads it back by the text.
      expect(yield* locationHandlers.resolveLocation({ location })).toEqual(picked);
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(setup(client)));
  });
});

/** The lookup asked about a name the words did not call a place. */
const asked = (location: string) => locationHandlers.placeCandidates({ location, possible: true });

describe('a possible place', () => {
  // A name a first phrase ends in that no word calls a place ("… im
  // Figlmüller", "im Regen"): the lookup answers only with proof.
  const figlmueller = {
    address: 'Bäckerstraße 6, 1010 Vienna, Austria',
    lat: 48.209,
    lng: 16.376,
    name: 'Figlmüller',
  };
  const branch = { ...figlmueller, name: 'Figlmüller Bäckerstrasse' };
  const inVienna = seedPlaced([placedEvent('home', 1, VIENNA), placedEvent('work', 2, VIENNA)]);

  it.effect('is the nearby venue called exactly that, the proof first', () => {
    // MapKit's own order for "Figlmüller": the search's branch, the completer's venue.
    const { client } = mapkit({
      found: { Figlmüller: [branch] },
      rows: { Figlmüller: [{ subtitle: figlmueller.address, title: 'Figlmüller' }] },
    });
    const withRows: GeoClientShape = {
      ...client,
      resolve: (request) =>
        request.suggestion === undefined ? client.resolve(request) : Effect.succeed([figlmueller]),
    };
    return Effect.gen(function* () {
      yield* inVienna;
      const candidates = yield* asked('Figlmüller');
      expect(candidates.map((c) => [c.geo.name, c.match])).toEqual([
        ['Figlmüller', 'exact'],
        ['Figlmüller Bäckerstrasse', 'words'],
      ]);
      expect(preselectedPlace(candidates)?.geo.source).toBe(
        'Figlmüller, Bäckerstraße 6, 1010 Vienna, Austria',
      );
    }).pipe(Effect.provide(setup(withRows)));
  });

  it.effect('is the place the user has been to, written exactly that', () => {
    const { client } = mapkit({});
    return Effect.gen(function* () {
      yield* seedPlaced([
        placedEvent('home', 1, VIENNA),
        new EventRecord({
          ...placedEvent('lunch', 30, VIENNA),
          geo: new GeoLocation({ lat: 48.21, lng: 16.36, source: 'Mercato' }),
          location: 'Mercato',
        }),
      ]);
      expect((yield* asked('Mercato')).map((c) => [c.source, c.geo.source, c.match])).toEqual([
        ['history', 'Mercato', 'exact'],
      ]);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect(
    'is the past place on its own without a bridge, and none picked far from the user’s places',
    () =>
      Effect.gen(function* () {
        yield* seedPlaced([
          placedEvent('home', 1, VIENNA),
          new EventRecord({
            ...placedEvent('lunch', 30, VIENNA),
            geo: new GeoLocation({ lat: 48.21, lng: 16.36, source: 'Mercato' }),
            location: 'Mercato',
          }),
          // Review (Opus): a bar picked on a trip four months back.
          new EventRecord({
            ...placedEvent('trip', 120, { lat: 48.8566, lng: 2.3522 }),
            geo: new GeoLocation({
              lat: 48.8566,
              lng: 2.3522,
              name: 'Anna',
              source: 'Anna, 12 Rue de Rivoli, 75004 Paris, France',
            }),
            location: 'Anna, 12 Rue de Rivoli, 75004 Paris, France',
          }),
        ]);
        expect((yield* asked('Mercato')).map((c) => [c.source, c.geo.source])).toEqual([
          ['history', 'Mercato'],
        ]);
        expect(yield* asked('Anna')).toEqual([]);
        // Said outright, the trip's place is the one, as it was.
        expect(
          (yield* locationHandlers.placeCandidates({ location: 'Anna' })).map((c) => c.geo.source),
        ).toContain('Anna, 12 Rue de Rivoli, 75004 Paris, France');
      }).pipe(Effect.provide(setup(unavailableGeoClient('off')))),
  );

  it.effect('is nothing where the hits only resemble the name', () => {
    // What MapKit answered around Vienna (probe, 2026-11-10), and a venue
    // and an office made up for what it did not have.
    const { client } = mapkit({
      found: {
        Anna: [
          {
            address: 'Annagasse, 1010 Vienna, Austria',
            lat: 48.204,
            lng: 16.372,
            name: 'Annagasse',
          },
          {
            address: 'Philharmonikerstraße 4, 1010 Vienna',
            lat: 48.2038,
            lng: 16.3695,
            name: 'Anna Sacher',
          },
          {
            address: '12 Rue de Rivoli, 75004 Paris, France',
            lat: 48.8566,
            lng: 2.3522,
            name: 'Anna',
          },
        ],
        Bett: [
          {
            address: 'Schmidtstraße 12, 60326 Frankfurt, Germany',
            lat: 50.103,
            lng: 8.619,
            name: 'Bett',
          },
        ],
        "Luigi's": [
          {
            address: 'Liechtensteinstraße 8, 1090 Vienna, Austria',
            lat: 48.217,
            lng: 16.363,
            name: 'Da Luigi',
          },
        ],
        Microsoft: [
          {
            address: 'Am Europlatz 3, 1120 Vienna, Austria',
            lat: 48.171,
            lng: 16.334,
            name: 'Microsoft Österreich',
          },
        ],
        Regen: [
          { address: 'Regen, Bavaria, Germany', lat: 48.97, lng: 13.13, name: 'Regen' },
          { address: 'Regen, Lower Austria, Austria', lat: 48.3, lng: 16.2, name: 'Regen' },
        ],
        Thanksgiving: [
          {
            address: '3003 N Thanksgiving Way, Lehi, UT 84043, United States',
            lat: 40.426,
            lng: -111.888,
            name: 'Thanksgiving Point',
          },
        ],
      },
    });
    return Effect.gen(function* () {
      yield* inVienna;
      for (const name of ['Anna', 'Bett', "Luigi's", 'Microsoft', 'Regen', 'Thanksgiving', 'EOD']) {
        expect(yield* asked(name), name).toEqual([]);
      }
      // Said outright as the place, the same hits are there to choose from.
      expect(
        (yield* locationHandlers.placeCandidates({ location: 'Anna' }))
          .filter((c) => c.source === 'mapkit')
          .map((c) => c.geo.name),
      ).toEqual(['Annagasse', 'Anna Sacher', 'Anna']);
    }).pipe(Effect.provide(setup(client)));
  });

  it.effect(
    'is the venue called exactly a name that is a person’s too, when it stands nearby',
    () => {
      const { client } = mapkit({
        found: {
          Anna: [
            { address: 'Neubaugasse 2, 1070 Vienna, Austria', lat: 48.2, lng: 16.35, name: 'Anna' },
          ],
        },
      });
      return Effect.gen(function* () {
        yield* inVienna;
        const [first] = yield* asked('Anna');
        expect([first?.source, first?.geo.name, first?.match]).toEqual(['mapkit', 'Anna', 'exact']);
      }).pipe(Effect.provide(setup(client)));
    },
  );

  it.effect(
    'takes a hit a day trip from the zone’s city, and none where nothing says where the user is',
    () => {
      const munich = {
        address: 'Tal 1, 80331 München, Germany',
        lat: 48.1351,
        lng: 11.582,
        name: 'Mercato',
      };
      const berlin = {
        address: 'Torstraße 1, 10119 Berlin, Germany',
        lat: 52.5296,
        lng: 13.4094,
        name: 'Mercato',
      };
      const { client } = mapkit({ found: { Mercato: [munich, berlin] } });
      return Effect.gen(function* () {
        // No zone the table knows and no event with a place: nothing is close.
        expect(yield* asked('Mercato')).toEqual([]);
        yield* writeTimeZoneSettings({
          primary: 'Europe/Berlin',
          zones: [DEVICE_ZONE, 'Europe/Berlin'],
        });
        yield* TestClock.adjust(REGION_HINT_TTL_MS + 1);
        // The zone holds Munich too, but a name needs its city's day trip.
        expect((yield* asked('Mercato')).map((c) => [c.address, c.match])).toEqual([
          ['Torstraße 1, 10119 Berlin, Germany', 'exact'],
          ['Tal 1, 80331 München, Germany', 'exact'],
        ]);
        expect(
          (yield* locationHandlers.placeCandidates({ location: 'Mercato' })).map((c) => c.address),
        ).toEqual(['Tal 1, 80331 München, Germany', 'Torstraße 1, 10119 Berlin, Germany']);
      }).pipe(Effect.provide(setup(client)));
    },
  );

  it.effect('is nothing when MapKit fails, stalls or is not there', () => {
    const failing: GeoClientShape = {
      resolve: () =>
        Effect.fail(new GeoRequestError({ message: 'offline', method: 'geo.resolve' })),
      search: () => Effect.fail(new GeoRequestError({ message: 'offline', method: 'geo.search' })),
      snapshot: () => Effect.succeed(FAKE_MAP_PNG_BASE64),
    };
    return Effect.gen(function* () {
      yield* inVienna;
      expect(yield* asked('Figlmüller')).toEqual([]);
    }).pipe(Effect.provide(setup(failing)));
  });

  it.effect('is nothing when the search answers past its budget', () => {
    const slow: GeoClientShape = {
      resolve: () => Effect.succeed([figlmueller]).pipe(Effect.delay('10 seconds')),
      search: () => Effect.succeed([]).pipe(Effect.delay('10 seconds')),
      snapshot: () => Effect.succeed(FAKE_MAP_PNG_BASE64),
    };
    return Effect.gen(function* () {
      yield* inVienna;
      const pending = yield* Effect.forkChild(asked('Figlmüller'));
      yield* TestClock.adjust(CANDIDATE_SEARCH_TIMEOUT);
      expect(yield* Fiber.join(pending)).toEqual([]);
    }).pipe(Effect.provide(setup(slow)));
  });

  it.effect('is nothing without a bridge, and nothing for a link', () => {
    return Effect.gen(function* () {
      yield* inVienna;
      expect(yield* asked('Figlmüller')).toEqual([]);
      expect(yield* asked('https://zoom.us/j/123')).toEqual([]);
    }).pipe(Effect.provide(setup(unavailableGeoClient('off'))));
  });
});
