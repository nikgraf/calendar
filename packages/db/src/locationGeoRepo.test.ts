import { GeoLocation } from '@calendar/core';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import { describe } from 'vitest';
import { LocationGeoRepo } from './locationGeoRepo.ts';
import { runMigrations } from './migrate.ts';

const freshDbLayer = () =>
  LocationGeoRepo.layer.pipe(
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
  );

const geo = new GeoLocation({ lat: 48.2, lng: 16.37, name: 'Naschmarkt', source: 'Naschmarkt' });

describe('LocationGeoRepo', () => {
  it.effect('returns null for an unknown key', () =>
    Effect.gen(function* () {
      const repo = yield* LocationGeoRepo;
      expect(yield* repo.get('nowhere')).toBeNull();
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('stores hits and misses, and overwrites on refresh', () =>
    Effect.gen(function* () {
      const repo = yield* LocationGeoRepo;
      yield* repo.set('naschmarkt', geo, 10);
      yield* repo.set('atlantis', null, 11);
      expect(yield* repo.get('naschmarkt')).toEqual({ geo, resolvedAt: 10 });
      expect(yield* repo.get('atlantis')).toEqual({ geo: null, resolvedAt: 11 });

      yield* repo.set('atlantis', geo, 12);
      expect(yield* repo.get('atlantis')).toEqual({ geo, resolvedAt: 12 });
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('reads an unreadable stored value as a miss', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const repo = yield* LocationGeoRepo;
      yield* sql`INSERT INTO location_geo VALUES ('bad', '{"lat":1}', 5)`;
      expect(yield* repo.get('bad')).toEqual({ geo: null, resolvedAt: 5 });
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('clear empties the table', () =>
    Effect.gen(function* () {
      const repo = yield* LocationGeoRepo;
      yield* repo.set('naschmarkt', geo, 10);
      yield* repo.clear();
      expect(yield* repo.get('naschmarkt')).toBeNull();
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('prunes expired misses and the oldest rows past the cap', () =>
    Effect.gen(function* () {
      const repo = yield* LocationGeoRepo;
      yield* repo.set('old-miss', null, 1);
      yield* repo.set('fresh-miss', null, 50);
      for (let index = 0; index < 5; index += 1) {
        yield* repo.set(`hit-${index}`, geo, 10 + index);
      }
      yield* repo.prune(40, 4);
      expect(yield* repo.get('old-miss')).toBeNull();
      expect(yield* repo.get('fresh-miss')).not.toBeNull();
      expect(yield* repo.get('hit-0')).toBeNull();
      expect(yield* repo.get('hit-1')).toBeNull();
      expect(yield* repo.get('hit-4')).not.toBeNull();
    }).pipe(Effect.provide(freshDbLayer())),
  );
});
