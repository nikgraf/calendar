import { GeoLocation } from '@calendar/core';
import { Context, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { LOCATION_GEO_KEY } from './keys.ts';
import { type LocationGeoRow, locationGeoFromRow } from './rows.ts';

/**
 * On-device geocoding results per normalized location string (see
 * normalizeLocationKey). Device-local like device_settings: no account
 * guard, never synced. Writes invalidate LOCATION_GEO_KEY so an editor
 * showing a cached place picks up a background refresh (or a wipe).
 */
export interface LocationGeoEntry {
  /** null = looked up, nothing found. */
  readonly geo: GeoLocation | null;
  readonly resolvedAt: number;
}

export interface LocationGeoRepoShape {
  /** Wipes the cache; every place is looked up afresh from then on. */
  readonly clear: () => Effect.Effect<void, SqlError>;
  readonly get: (locationKey: string) => Effect.Effect<LocationGeoEntry | null, SqlError>;
  /**
   * Drops misses recorded before `missesBefore` and, past `keep` rows, the
   * least recently resolved ones — the table would otherwise grow by one
   * row per distinct string ever looked up.
   */
  readonly prune: (missesBefore: number, keep: number) => Effect.Effect<void, SqlError>;
  readonly set: (
    locationKey: string,
    geo: GeoLocation | null,
    resolvedAt: number,
  ) => Effect.Effect<void, SqlError>;
}

const encodeGeo = Schema.encodeSync(GeoLocation);

const makeLocationGeoRepo: Effect.Effect<LocationGeoRepoShape, never, Reactivity | SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const reactivity = yield* Reactivity;
    return {
      clear: () =>
        reactivity.mutation([LOCATION_GEO_KEY], Effect.asVoid(sql`DELETE FROM location_geo`)),
      get: (locationKey) =>
        Effect.map(
          sql<LocationGeoRow>`SELECT * FROM location_geo WHERE location_key = ${locationKey}`,
          (rows) => {
            const row = rows[0];
            return row ? { geo: locationGeoFromRow(row), resolvedAt: row.resolved_at } : null;
          },
        ),
      prune: (missesBefore, keep) =>
        Effect.asVoid(
          Effect.andThen(
            sql`DELETE FROM location_geo WHERE geo IS NULL AND resolved_at < ${missesBefore}`,
            sql`DELETE FROM location_geo WHERE location_key IN (
              SELECT location_key FROM location_geo
              ORDER BY resolved_at DESC LIMIT -1 OFFSET ${keep})`,
          ),
        ),
      set: (locationKey, geo, resolvedAt) =>
        reactivity.mutation(
          [LOCATION_GEO_KEY],
          Effect.asVoid(sql`
            INSERT INTO location_geo (location_key, geo, resolved_at)
            VALUES (${locationKey}, ${geo ? JSON.stringify(encodeGeo(geo)) : null}, ${resolvedAt})
            ON CONFLICT (location_key) DO UPDATE SET
              geo = excluded.geo,
              resolved_at = excluded.resolved_at
          `),
        ),
    };
  });

export class LocationGeoRepo extends Context.Service<LocationGeoRepo, LocationGeoRepoShape>()(
  'db/LocationGeoRepo',
) {
  static readonly layer: Layer.Layer<LocationGeoRepo, never, Reactivity | SqlClient> =
    Layer.effect(LocationGeoRepo)(makeLocationGeoRepo);
}
