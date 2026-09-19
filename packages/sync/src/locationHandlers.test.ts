import { GeoLocation } from '@calendar/core';
import { LocationGeoRepo, runMigrations } from '@calendar/db';
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
import { describe } from 'vitest';
import { LOCATION_MISS_TTL_MS, locationHandlers } from './locationHandlers.ts';

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
    LocationGeoRepo.layer.pipe(
      Layer.provideMerge(Layer.effectDiscard(runMigrations)),
      Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    ),
  );

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
