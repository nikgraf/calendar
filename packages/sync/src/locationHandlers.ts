import {
  type BackendHandlers,
  densestRegion,
  GeoLocation,
  type GeoRegion,
  isMappableLocation,
  mergePlaceCandidates,
  namesFound,
  normalizeLocationKey,
  type PastPlace,
  type PlaceCandidate,
  placeMatch,
  placeSuggestionLabel,
  rankFoundPlaces,
  rankPastPlaces,
  regionForTimeZone,
  withFoundSuggestions,
} from '@calendar/core';
import { type DeviceSettingsRepo, EventRepo, LocationGeoRepo } from '@calendar/db';
import { GeoClient, type GeoPlaceJson } from '@calendar/geo';
import { Clock, Effect, Ref } from 'effect';
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
/** The past places last read, per event store: a year's occurrences are not expanded per turn. */
const pastPlaces = new WeakMap<
  object,
  { readonly at: number; readonly places: ReadonlyArray<PastPlace> }
>();
/**
 * How long the candidates wait for MapKit: a draft is being made, and
 * its title and times must not hang on a search (the helper's own
 * timeout is 15 s). Past it, the past places answer alone.
 */
export const CANDIDATE_SEARCH_TIMEOUT = '3 seconds';
/**
 * How long the typeahead waits for the search that fills in where the
 * completer runs short: past it, the completer's rows are the answer.
 */
export const TYPEAHEAD_SEARCH_TIMEOUT = '1 second';
/**
 * Fill-in searches the typeahead makes per minute at most. MapKit
 * throttles searches (about fifty a minute, then every one fails for a
 * while — the pins and the picks too), and typing must not spend them.
 */
export const FILL_IN_LIMIT = 20;
export const FILL_IN_WINDOW_MS = 60 * 1000;
/** Per geo client: the number of the typeahead's latest call, and when its recent fill-in searches began. */
const fillIns = new WeakMap<object, { latest: number; started: ReadonlyArray<number> }>();
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
 * nowhere in particular. Nearby is near any of those events or the
 * zone's city. A hint for MapKit, never a filter, and never a
 * location permission; it also says how far from there a place still is
 * nearby (`isNearby`), which decides what is taken unasked.
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
  const zone = yield* readPrimaryTimeZone.pipe(
    Effect.map(regionForTimeZone),
    Effect.orElseSucceed(() => undefined),
  );
  const history = densestRegion(points);
  // The zone's city is near too: a trip's events must not make home far
  // when home has no event with a place.
  const region =
    history === undefined
      ? zone
      : zone === undefined
        ? history
        : {
            ...history,
            near: {
              ...history.near,
              points: [...history.near.points, { lat: zone.lat, lng: zone.lng }],
            },
          };
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
      // occurrence's place with the text it was written as — read once
      // per `REGION_HINT_TTL_MS`, like the region hint.
      const now = yield* Clock.currentTimeMillis;
      const store = yield* EventRepo;
      const known = pastPlaces.get(store);
      let places: ReadonlyArray<PastPlace>;
      if (known && now - known.at < REGION_HINT_TTL_MS) {
        places = known.places;
      } else {
        const past = yield* loadEventsInRange(now - PLACE_HISTORY_MS, now).pipe(
          Effect.orElseSucceed((): ReadonlyArray<EventRecord> => []),
        );
        places = past.flatMap((event) =>
          event.geo !== undefined && event.status !== 'cancelled'
            ? [{ geo: event.geo, lastUsedUtc: event.startUtc }]
            : [],
        );
        pastPlaces.set(store, { at: now, places });
      }
      const history = rankPastPlaces(location, places);
      // Then MapKit, asked two ways side by side: the natural-language
      // search, which reads a misspelling, and the completer's rows,
      // which know a place's branches, each row resolved to its exact
      // place. The hits the text names come first — resembling it, and
      // nearby or where it says — the others after them, to pick from
      // (`rankFoundPlaces`). Each carries the text a pick writes: the
      // name and address, as a picked typeahead row would.
      const geo = yield* GeoClient;
      const region = yield* regionHint;
      // Each way on its own clock: what one answers is kept when the
      // other stalls.
      const searched = geo.resolve({ limit: CANDIDATE_LIMIT, query: location, region }).pipe(
        Effect.timeout(CANDIDATE_SEARCH_TIMEOUT),
        Effect.catch(() => Effect.succeed([])),
      );
      // The rows within the same budget, each kept as it resolves: one
      // that stalls costs itself, not the ones that answered. In the
      // completer's order — the first of them may be the one taken.
      const resolved = yield* Ref.make(new Map<number, GeoPlaceJson>());
      const completed = geo.search({ limit: CANDIDATE_LIMIT, query: location, region }).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(
            rows,
            (row, index) =>
              geo.resolve({ limit: 1, query: placeSuggestionLabel(row), suggestion: row }).pipe(
                Effect.flatMap((places) => {
                  const place = places[0];
                  return place === undefined
                    ? Effect.void
                    : Ref.update(resolved, (byRow) => new Map(byRow).set(index, place));
                }),
                Effect.catch(() => Effect.void),
              ),
            { concurrency: 'unbounded', discard: true },
          ),
        ),
        Effect.timeout(CANDIDATE_SEARCH_TIMEOUT),
        Effect.catch(() => Effect.void),
        Effect.flatMap(() => Ref.get(resolved)),
        Effect.map((byRow) =>
          [...byRow.entries()].sort(([a], [b]) => a - b).map(([, place]) => place),
        ),
      );
      const [fromSearch, fromRows] = yield* Effect.all([searched, completed], {
        concurrency: 'unbounded',
      });
      const found = rankFoundPlaces(location, [...fromSearch, ...fromRows], region).map(
        ({ match, place }): PlaceCandidate => {
          const name = place.name ?? location;
          return {
            ...(place.address ? { address: place.address } : {}),
            geo: new GeoLocation({
              lat: place.lat,
              lng: place.lng,
              name: place.name,
              source: place.address ? `${name}, ${place.address}` : name,
            }),
            match,
            source: 'mapkit',
          };
        },
      );
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
      // best match that it names — a search answers something for almost
      // any text ("Room 4" found a street in Weidling, "Cafe Meek" a
      // café in South Africa), so a hit counts only when its name or
      // address says it is what was typed and it is nearby or where the
      // text says (`rankFoundPlaces`).
      const lookup = Effect.gen(function* () {
        const region = suggestion === undefined ? yield* regionHint : undefined;
        const places = yield* geo.resolve({
          limit: suggestion === undefined ? CANDIDATE_LIMIT : 1,
          query: location,
          region,
          suggestion,
        });
        if (suggestion !== undefined) {
          return { remember: true, result: places[0] ?? null };
        }
        const [best] = rankFoundPlaces(location, places, region);
        const result = best !== undefined && best.match !== 'search' ? best.place : null;
        // A place the text names that is only too far is a "no" for where
        // the user is now, not "no such place": a later region may take it.
        // A kind of place alone ("home") names none of them for good,
        // unless one is called exactly that.
        const farOnly = result === null && places.some((place) => namesFound(location, place));
        return { remember: !farOnly, result };
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
      const store = (
        place: { readonly remember: boolean; readonly result: GeoPlaceJson | null } | undefined,
      ) =>
        Effect.gen(function* () {
          if (place === undefined) {
            return null;
          }
          const resolved = place.result && toGeo(place.result, location);
          if (!place.remember) {
            return resolved;
          }
          yield* cache.set(key, resolved, now);
          yield* cache.prune(now - LOCATION_MISS_TTL_MS, LOCATION_CACHE_ROWS);
          return resolved;
        });

      // A row the search found came with its coordinates: the pick is
      // that place, with nothing to look up.
      if (suggestion?.coordinates !== undefined) {
        return yield* store({
          remember: true,
          result: { ...suggestion.coordinates, name: suggestion.title },
        });
      }
      // A picked suggestion is a fresh, exact answer; free text may be cached.
      if (suggestion === undefined) {
        const cached = yield* cache.get(key);
        if (cached?.geo !== null && cached !== null) {
          if (now - cached.resolvedAt > LOCATION_REFRESH_AFTER_MS) {
            // Stale-while-revalidate: the cache write invalidates
            // LOCATION_GEO_KEY, so an open editor re-reads the fresh answer.
            // A hit the current rule refuses gives way to a miss: kept, it
            // would be served on and asked about on every read.
            yield* Effect.forkDetach(
              Effect.flatMap(lookup, (place) => store(place && { ...place, remember: true })),
            );
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
      const calls = fillIns.get(geo) ?? { latest: 0, started: [] };
      fillIns.set(geo, calls);
      calls.latest += 1;
      const mine = calls.latest;
      const region = yield* regionHint;
      const wanted = clamp(limit ?? DEFAULT_PLACE_LIMIT, 1, 10);
      const rows = yield* geo
        .search({ limit: wanted, query, region })
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (rows === undefined) {
        return [];
      }
      // Rows enough, one that is the text itself ("kaffemik" completes to
      // Kaffemik), or a newer keystroke already asked: nothing to fill in
      // (the completer answers a query it dropped for a newer one with no
      // rows at all, and that text is no longer the one on screen).
      if (
        rows.length >= wanted ||
        rows.some((row) => placeMatch(query, { name: row.title }) === 'exact') ||
        calls.latest !== mine
      ) {
        return rows;
      }
      const now = yield* Clock.currentTimeMillis;
      const recent = calls.started.filter((at) => now - at < FILL_IN_WINDOW_MS);
      if (recent.length >= FILL_IN_LIMIT) {
        return rows;
      }
      calls.started = [...recent, now];
      // The completer runs short: the text is nearly a whole name, or one
      // it cannot complete — it reads only how a name begins, and a letter
      // off ("kaffeemik", "figlmuler") it answers with a namesake far away
      // or nothing. The search reads the misspelling; the places it finds
      // that the text names go first.
      const found = yield* geo.resolve({ limit: CANDIDATE_LIMIT, query, region }).pipe(
        Effect.timeout(TYPEAHEAD_SEARCH_TIMEOUT),
        Effect.catch(() => Effect.succeed([])),
      );
      return withFoundSuggestions(rows, rankFoundPlaces(query, found, region), wanted);
    }),
};
