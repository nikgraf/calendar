import {
  type BackendHandlers,
  densestRegion,
  GeoLocation,
  type GeoRegion,
  isMappableLocation,
  mergePlaceCandidates,
  normalizeLocationKey,
  type PlaceCandidate,
  placeMatch,
  placesResembling,
  rankPastPlaces,
  regionForTimeZone,
} from '@calendar/core';
import { type DeviceSettingsRepo, EventRepo, LocationGeoRepo } from '@calendar/db';
import { GeoClient, type GeoPlaceJson } from '@calendar/geo';
import { Clock, Effect } from 'effect';
import type { EventRecord } from '@calendar/core';
import type { AppleCalendarEvents } from './appleCalendarEvents.ts';
import { readPrimaryTimeZone } from './deviceSettings.ts';
import { loadEventsInRange } from './eventsInRange.ts';

/** Typeahead only kicks in once the text can narrow anything down. */
const MIN_SEARCH_LENGTH = 3;
const DEFAULT_PLACE_LIMIT = 6;
/**
 * A recorded "nothing found" is trusted this long before MapKit is asked
 * again (synchronously — there is nothing to show meanwhile).
 */
export const LOCATION_MISS_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * A hit older than this is still shown at once, but re-resolved in the
 * background: places open, move and close, and the text may now name a
 * different one. A place in constant use refreshes on this cadence too,
 * since every refresh restamps its row.
 */
export const LOCATION_REFRESH_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
/** Rows kept in the cache; past this the least recently resolved go. */
const LOCATION_CACHE_ROWS = 2000;
/** Matches asked of MapKit for free text: the best guess and a few alternatives. */
const CANDIDATE_LIMIT = 5;
/** How far back the user's events say where they are. */
const REGION_HISTORY_MS = 90 * 24 * 60 * 60 * 1000;
/** How far back the user's events say where they have been: the past places a text may name. */
const PLACE_HISTORY_MS = 365 * 24 * 60 * 60 * 1000;
/**
 * How long a region hint is reused: the typeahead asks on every pause
 * in typing, and the hint reads a quarter's events (EventKit too).
 */
export const REGION_HINT_TTL_MS = 5 * 60 * 1000;
/** The hint last computed, per event store (one per app; one per test). */
const regionHints = new WeakMap<
  object,
  { readonly at: number; readonly region: GeoRegion | undefined }
>();

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Number.isFinite(value) ? value : min, min), max);

const toGeo = (place: GeoPlaceJson, location: string): GeoLocation =>
  new GeoLocation({ lat: place.lat, lng: place.lng, name: place.name, source: location });

/**
 * Where to look first: around the densest cluster of the coordinates on
 * the user's events of the last 90 days — the occurrences that were
 * (`loadEventsInRange`: series expanded, cancellations out, Apple
 * events read through), the most recent first, so a tie goes to where
 * they were last — else the city of the primary time zone, else
 * nowhere in particular. A hint for MapKit, never a filter, and never a
 * location permission.
 */
export const regionHint: Effect.Effect<
  GeoRegion | undefined,
  never,
  AppleCalendarEvents | DeviceSettingsRepo | EventRepo
> = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  const store = yield* EventRepo;
  const known = regionHints.get(store);
  if (known && now - known.at < REGION_HINT_TTL_MS) {
    return known.region;
  }
  const events = yield* loadEventsInRange(now - REGION_HISTORY_MS, now);
  const points = events
    .filter((event) => event.geo !== undefined && event.status !== 'cancelled')
    .sort((a, b) => b.startUtc - a.startUtc)
    .map((event) => ({ lat: event.geo!.lat, lng: event.geo!.lng }));
  const region = densestRegion(points) ?? regionForTimeZone(yield* readPrimaryTimeZone);
  regionHints.set(store, { at: now, region });
  return region;
}).pipe(Effect.orElseSucceed(() => undefined));

type LocationMethods =
  | 'clearLocationCache'
  | 'mapSnapshot'
  | 'placeCandidates'
  | 'resolveLocation'
  | 'searchPlaces';

/**
 * Place search, geocoding and map images. On-device only (MapKit through
 * the platform's GeoClient); geocoding runs on demand — when an editor
 * opens or a suggestion is picked — never during sync, so Apple's rate
 * limits are never in play. A missing bridge (e2e, old iOS dev client)
 * degrades to "no suggestions, no map" rather than an error.
 */
export const locationHandlers: Pick<
  BackendHandlers<
    AppleCalendarEvents | DeviceSettingsRepo | EventRepo | GeoClient | LocationGeoRepo
  >,
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

  placeCandidates: ({ location }) =>
    Effect.gen(function* () {
      if (!isMappableLocation(location)) {
        return [];
      }
      // The user's own past places first: a year of events, each
      // occurrence's place with the text it was written as.
      const now = yield* Clock.currentTimeMillis;
      const past = yield* loadEventsInRange(now - PLACE_HISTORY_MS, now).pipe(
        Effect.orElseSucceed((): ReadonlyArray<EventRecord> => []),
      );
      const history = rankPastPlaces(
        location,
        past.flatMap((event) =>
          event.geo !== undefined && event.status !== 'cancelled'
            ? [{ geo: event.geo, lastUsedUtc: event.startUtc }]
            : [],
        ),
      );
      // Then MapKit's matches, each with the text a pick writes: the
      // name and address, as a picked typeahead row would.
      const geo = yield* GeoClient;
      const region = yield* regionHint;
      const places = yield* geo
        .resolve({ limit: CANDIDATE_LIMIT, query: location, region })
        .pipe(Effect.catch(() => Effect.succeed([])));
      const found = placesResembling(location, places).flatMap((place): Array<PlaceCandidate> => {
        const match = placeMatch(location, place);
        if (match === undefined) {
          return [];
        }
        const name = place.name ?? location;
        return [
          {
            ...(place.address ? { address: place.address } : {}),
            geo: new GeoLocation({
              lat: place.lat,
              lng: place.lng,
              name: place.name,
              source: place.address ? `${name}, ${place.address}` : name,
            }),
            match,
            source: 'mapkit',
          },
        ];
      });
      return mergePlaceCandidates(history, found);
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

      // A picked suggestion is that exact place. Free text gets MapKit's
      // best match that resembles it — a search answers something for
      // almost any text ("Room 4" found a street in Weidling), so a hit
      // counts only when its name or address says it is what was typed.
      const lookup = Effect.gen(function* () {
        const region = suggestion === undefined ? yield* regionHint : undefined;
        const places = yield* geo.resolve({
          limit: suggestion === undefined ? CANDIDATE_LIMIT : 1,
          query: location,
          region,
          suggestion,
        });
        const result =
          (suggestion === undefined ? placesResembling(location, places)[0] : places[0]) ?? null;
        return { result };
      }).pipe(
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
      const region = yield* regionHint;
      return yield* geo
        .search({ limit: clamp(limit ?? DEFAULT_PLACE_LIMIT, 1, 10), query, region })
        .pipe(Effect.catch(() => Effect.succeed([])));
    }),
};
