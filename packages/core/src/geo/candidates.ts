import { Schema } from 'effect';
import { GeoLocation } from '../types.ts';
import { normalizeLocationKey } from './location.ts';
import { distanceMeters } from './regions.ts';
import { type PlaceMatch, placeMatch } from './resemblance.ts';

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
  /** How it resembles the text; `search`: a hit that does not, offered but never taken unasked. */
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
 * name for it beside that text.
 */
export const pastPlaceMatch = (text: string, geo: GeoLocation): PlaceMatch | undefined =>
  best(
    placeMatch(text, { name: geo.source }),
    geo.name === undefined ? undefined : placeMatch(text, { address: geo.source, name: geo.name }),
  );

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

/** Nearer than this, a hit is a place already listed over again. */
const SAME_PLACE_METERS = 100;

/** Whether the place is one already listed: the same text, or within a hundred meters. */
const listed = (place: GeoLocation, among: ReadonlyArray<PlaceCandidate>): boolean =>
  among.some(
    (candidate) =>
      normalizeLocationKey(candidate.geo.source) === normalizeLocationKey(place.source) ||
      distanceMeters(candidate.geo, place) <= SAME_PLACE_METERS,
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

/**
 * The candidate a turn takes without asking: the best one, when it
 * resembles the text at all — a past place, or a search match by name,
 * words or sound. A hit that does not resemble the text is offered, never
 * taken: the text stays as said.
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
