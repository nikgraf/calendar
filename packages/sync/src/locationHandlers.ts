import {
  type BackendHandlers,
  GeoLocation,
  isMappableLocation,
  normalizeLocationKey,
} from '@calendar/core';
import { LocationGeoRepo } from '@calendar/db';
import { GeoClient, type GeoPlaceJson } from '@calendar/geo';
import { Clock, Effect } from 'effect';

/** Typeahead only kicks in once the text can narrow anything down. */
const MIN_SEARCH_LENGTH = 3;
const DEFAULT_PLACE_LIMIT = 6;
/**
 * A recorded "nothing found" is trusted this long before MapKit is asked
 * again (synchronously — there is nothing to show meanwhile).
 */
export const LOCATION_MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A hit older than this is still shown at once, but re-resolved in the
 * background: places open, move and close, and the text may now name a
 * different one. A place in constant use refreshes on this cadence too,
 * since every refresh restamps its row.
 */
export const LOCATION_REFRESH_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Rows kept in the cache; past this the least recently resolved go. */
const LOCATION_CACHE_ROWS = 2000;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Number.isFinite(value) ? value : min, min), max);

const toGeo = (place: GeoPlaceJson, location: string): GeoLocation =>
  new GeoLocation({ lat: place.lat, lng: place.lng, name: place.name, source: location });

type LocationMethods = 'clearLocationCache' | 'mapSnapshot' | 'resolveLocation' | 'searchPlaces';

/**
 * Place search, geocoding and map images. On-device only (MapKit through
 * the platform's GeoClient); geocoding runs on demand — when an editor
 * opens or a suggestion is picked — never during sync, so Apple's rate
 * limits are never in play. A missing bridge (e2e, old iOS dev client)
 * degrades to "no suggestions, no map" rather than an error.
 */
export const locationHandlers: Pick<
  BackendHandlers<GeoClient | LocationGeoRepo>,
  LocationMethods
> = {
  clearLocationCache: () => Effect.flatMap(LocationGeoRepo, (cache) => cache.clear()),

  mapSnapshot: ({ appearance, height, lat, lng, scale, width }) =>
    Effect.gen(function* () {
      const geo = yield* GeoClient;
      const pngBase64 = yield* geo.snapshot({
        appearance,
        height: Math.round(clamp(height, 1, 1200)),
        lat,
        lng,
        scale: clamp(scale, 1, 3),
        width: Math.round(clamp(width, 1, 1200)),
      });
      return { pngBase64 };
    }),

  resolveLocation: ({ location, suggestion }) =>
    Effect.gen(function* () {
      if (!isMappableLocation(location)) {
        return null;
      }
      const geo = yield* GeoClient;
      const cache = yield* LocationGeoRepo;
      const key = normalizeLocationKey(location);
      const now = yield* Clock.currentTimeMillis;

      const lookup = geo.resolve({ query: location, suggestion }).pipe(
        Effect.map((result) => ({ result })),
        // No bridge or a failed lookup (offline): nothing to show, and
        // nothing cached — a transient failure must not read as "no such place".
        Effect.catch((error) =>
          Effect.as(
            error._tag === 'GeoRequestError'
              ? Effect.logWarning('location lookup failed', { message: error.message })
              : Effect.void,
            undefined,
          ),
        ),
      );
      const store = (place: { readonly result: GeoPlaceJson | null } | undefined) =>
        Effect.gen(function* () {
          if (place === undefined) {
            return null;
          }
          const resolved = place.result && toGeo(place.result, location);
          yield* cache.set(key, resolved, now);
          yield* cache.prune(now - LOCATION_MISS_TTL_MS, LOCATION_CACHE_ROWS);
          return resolved;
        });

      // A picked suggestion is a fresh, exact answer; free text may be cached.
      if (suggestion === undefined) {
        const cached = yield* cache.get(key);
        if (cached?.geo !== null && cached !== null) {
          if (now - cached.resolvedAt > LOCATION_REFRESH_AFTER_MS) {
            // Stale-while-revalidate: the cache write invalidates
            // LOCATION_GEO_KEY, so an open editor re-reads the fresh answer.
            yield* Effect.forkDetach(Effect.flatMap(lookup, store));
          }
          return new GeoLocation({ ...cached.geo, source: location });
        }
        if (cached && now - cached.resolvedAt < LOCATION_MISS_TTL_MS) {
          return null;
        }
      }
      return yield* Effect.flatMap(lookup, store);
    }),

  searchPlaces: ({ limit, query }) =>
    Effect.gen(function* () {
      if (!isMappableLocation(query) || query.trim().length < MIN_SEARCH_LENGTH) {
        return [];
      }
      const geo = yield* GeoClient;
      return yield* geo
        .search({ limit: clamp(limit ?? DEFAULT_PLACE_LIMIT, 1, 10), query })
        .pipe(Effect.catch(() => Effect.succeed([])));
    }),
};
