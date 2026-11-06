import { Schema } from 'effect';
import { GeoLocation } from '../types.ts';
import { normalizeLocationKey, type PlaceSuggestion } from './location.ts';
import { distanceMeters, type GeoPoint, type GeoRegion, isNearby } from './regions.ts';
import {
  type PlaceLike,
  type PlaceMatch,
  placeMatch,
  sameAddress,
  saysWhere,
} from './resemblance.ts';

/**
 * The places a phrase's location text could mean, for a choice: the
 * user's own past places first — a place they have been to beats any
 * search hit, and a dictated "Cafe Zentral" is found among them by how
 * it sounds, where MapKit's search is not — then MapKit's matches.
 */

export const PlaceCandidate = Schema.Struct({
  /** MapKit's address, when it has one; a past place has only its text. */
  address: Schema.optional(Schema.String),
  /** The coordinates; `source` is the text the location field takes on a pick. */
  geo: GeoLocation,
  /**
   * How it resembles the text; `search`: a hit that does not, or one far
   * from the user's places that the text does not say is there — offered
   * but never taken unasked.
   */
  match: Schema.Literals(['exact', 'phonetic', 'search', 'words']),
  /** `history`: a place of the user's own past events; `mapkit`: a search match. */
  source: Schema.Literals(['history', 'mapkit']),
});
export type PlaceCandidate = typeof PlaceCandidate.Type;

/** A place a past event was at, with the text it was written as. */
export interface PastPlace {
  readonly geo: GeoLocation;
  readonly lastUsedUtc: number;
}

/** Candidates offered at most. */
export const PLACE_CANDIDATE_LIMIT = 5;

const RANK: Record<PlaceMatch, number> = { exact: 0, phonetic: 2, words: 1 };

/** The better of two matches, if any. */
const best = (a: PlaceMatch | undefined, b: PlaceMatch | undefined): PlaceMatch | undefined =>
  a === undefined ? b : b === undefined ? a : RANK[a] <= RANK[b] ? a : b;

/**
 * How a past place resembles the text: by the text it was written as
 * (what the user said last time — an exact "Figlmüller"), or by MapKit's
 * name for it beside that text. A picked place is written "name,
 * address": what follows the first comma is where it is, so "Vienna,
 * Austria" names no past place that merely stands there.
 */
export const pastPlaceMatch = (text: string, geo: GeoLocation): PlaceMatch | undefined => {
  if (normalizeLocationKey(text) === normalizeLocationKey(geo.source)) {
    return 'exact';
  }
  const [written = '', ...rest] = geo.source.split(',');
  const address = rest.join(',');
  return best(
    placeMatch(text, { address, name: written }),
    geo.name === undefined ? undefined : placeMatch(text, { address, name: geo.name }),
  );
};

/**
 * The past places the text names, best first — exact, then by words,
 * then by sound — the most recently used first among equals. One per
 * place text (the latest use of it).
 */
export const rankPastPlaces = (
  text: string,
  places: ReadonlyArray<PastPlace>,
): ReadonlyArray<PlaceCandidate> => {
  const latest = new Map<string, PastPlace>();
  for (const place of places) {
    const key = normalizeLocationKey(place.geo.source);
    const known = latest.get(key);
    if (known === undefined || place.lastUsedUtc > known.lastUsedUtc) {
      latest.set(key, place);
    }
  }
  const ranked = [...latest.values()]
    .flatMap((place) => {
      const match = pastPlaceMatch(text, place.geo);
      return match === undefined ? [] : [{ match, place }];
    })
    .sort((a, b) => RANK[a.match] - RANK[b.match] || b.place.lastUsedUtc - a.place.lastUsedUtc)
    .map(({ match, place }) => ({ geo: place.geo, match, source: 'history' as const }));
  // One place written two ways is one place: the better-ranked text stays.
  const once: Array<PlaceCandidate> = [];
  for (const candidate of ranked) {
    if (!listed(candidate.geo, once)) {
      once.push(candidate);
    }
  }
  return once;
};

/** Nearer than this, a hit of the same name is a place already listed over again. */
const SAME_PLACE_METERS = 100;

/** A place's name as its own: MapKit's, else the text it was written as. */
const nameOf = (place: GeoLocation): string => normalizeLocationKey(place.name ?? place.source);

/**
 * Whether the place is one already listed: the same text, or the same
 * name within a hundred meters (a branch around the corner with a name
 * of its own is another place).
 */
const listed = (place: GeoLocation, among: ReadonlyArray<PlaceCandidate>): boolean =>
  among.some(
    (candidate) =>
      normalizeLocationKey(candidate.geo.source) === normalizeLocationKey(place.source) ||
      (nameOf(candidate.geo) === nameOf(place) &&
        distanceMeters(candidate.geo, place) <= SAME_PLACE_METERS),
  );

/**
 * History first, then the search's hits in their order, each once (two
 * searches answer the same place; the same text, or within a hundred
 * meters, is one place), at most `limit` in all.
 */
export const mergePlaceCandidates = (
  history: ReadonlyArray<PlaceCandidate>,
  found: ReadonlyArray<PlaceCandidate>,
  limit: number = PLACE_CANDIDATE_LIMIT,
): ReadonlyArray<PlaceCandidate> => {
  const merged: Array<PlaceCandidate> = [...history];
  for (const candidate of found) {
    if (!listed(candidate.geo, merged)) {
      merged.push(candidate);
    }
  }
  return merged.slice(0, limit);
};

/** A place a search found: where it is and what MapKit calls it. */
export interface FoundPlace extends GeoPoint, PlaceLike {}

/** Far namesakes offered at most: the search's best one, for a trip the text does not name. */
const FAR_OFFERS = 1;

/**
 * What a search found for a text, each place with how far it may be
 * trusted, the ones to trust first. A hit is the place the text names
 * when it resembles the words (`placeMatch`) and is nearby (`isNearby`)
 * or the text says where it is (`saysWhere`): a search answers with a
 * namesake on another continent as readily as with nothing — "Cafe Meek"
 * found Meek Café in Benoni, 8,000 km from every event the user has. The
 * rest is `search`, offered and never taken: the nearby hits that do not
 * resemble the text, then one far namesake. Any other far hit is no
 * one's guess and is left out.
 */
export const rankFoundPlaces = <Place extends FoundPlace>(
  text: string,
  places: ReadonlyArray<Place>,
  region: GeoRegion | undefined,
): ReadonlyArray<{ readonly match: PlaceCandidate['match']; readonly place: Place }> => {
  const read = places.map((place, index) => {
    const match = placeMatch(text, place);
    const near = isNearby(region, place);
    const named = match !== undefined && (near || saysWhere(text, place)) ? match : undefined;
    // Named first, by how well; then the nearby rest; then far namesakes.
    const order = named !== undefined ? RANK[named] : near ? 3 : match !== undefined ? 4 : 5;
    return { index, named, order, place };
  });
  const far = read.filter((entry) => entry.order === 4).slice(0, FAR_OFFERS);
  return read
    .filter((entry) => entry.order < 4 || far.includes(entry))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(({ named, place }) => ({ match: named ?? ('search' as const), place }));
};

/**
 * The candidate a turn takes without asking: the best one, when it
 * resembles the text at all — a past place, or a search match by name,
 * words or sound that is nearby or where the text says. A hit that is
 * neither is offered, never taken: the text stays as said.
 */
export const preselectedPlace = (
  candidates: ReadonlyArray<PlaceCandidate>,
): PlaceCandidate | undefined => {
  const [first] = candidates;
  return first !== undefined && first.match !== 'search' ? first : undefined;
};

/** A candidate as a chip names it: a past place by its text, a search hit by its name and address. */
export const placeCandidateLabel = (candidate: PlaceCandidate): string => {
  if (candidate.source === 'history') {
    return candidate.geo.source;
  }
  const name = candidate.geo.name ?? candidate.geo.source;
  return candidate.address ? `${name} · ${candidate.address}` : name;
};

/** Whether two typeahead rows are one place: the same name at the same address. */
const sameRow = (a: PlaceSuggestion, b: PlaceSuggestion): boolean =>
  normalizeLocationKey(a.title) === normalizeLocationKey(b.title) &&
  sameAddress(a.subtitle, b.subtitle);

/**
 * The typeahead's rows once the search has filled in: the places it
 * found that the text names (`rankFoundPlaces`: resembling, and nearby
 * or where the text says) first, then the completer's rows, a place both
 * know listed once, at most `limit`. The completer reads only how a name
 * begins — one letter off ("kaffeemik" for Kaffemik) and it answers with
 * a namesake in another country or nothing, where the search reads the
 * misspelling.
 */
export const withFoundSuggestions = (
  rows: ReadonlyArray<PlaceSuggestion>,
  found: ReadonlyArray<{ readonly match: PlaceCandidate['match']; readonly place: FoundPlace }>,
  limit: number,
): ReadonlyArray<PlaceSuggestion> => {
  const named = found.flatMap(({ match, place }): ReadonlyArray<PlaceSuggestion> => {
    const title = place.name?.trim() ?? '';
    return match === 'search' || title === ''
      ? []
      : [
          {
            coordinates: { lat: place.lat, lng: place.lng },
            ...(place.address ? { subtitle: place.address } : {}),
            title,
          },
        ];
  });
  const merged: Array<PlaceSuggestion> = [];
  for (const row of [...named, ...rows]) {
    if (!merged.some((listed) => sameRow(listed, row))) {
      merged.push(row);
    }
  }
  return merged.slice(0, limit);
};
