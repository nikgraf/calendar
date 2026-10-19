import {
  type GeoLocation,
  normalizeLocationKey,
  type PlaceCandidate,
  preselectedPlace,
} from '@calendar/core';

/**
 * The places a turn's location text could mean: the candidates
 * (`placeCandidates`: past places first, then MapKit's hits) and the
 * text as said. The best one that resembles the text is taken at once;
 * the row stays, the taken one marked, so another can be picked (pin and
 * all) or the text had back as said.
 */
export interface PlaceChoice {
  readonly candidates: ReadonlyArray<PlaceCandidate>;
  readonly text: string;
}

/** What a turn found for the location text it set. */
export interface PlaceChange {
  readonly candidates: ReadonlyArray<PlaceCandidate>;
  /** The text the turn put in the location. */
  readonly text: string;
}

const same = (a: string, b: string): boolean => normalizeLocationKey(a) === normalizeLocationKey(b);

/**
 * The choice as it applies to the form now: only while the location
 * reads the text it was found for, or one of its candidates. Edited by
 * hand, picked from the typeahead or cleared, the field names something
 * else, and the chips would put an old place over it.
 */
export const livePlaceChoice = (
  choice: PlaceChoice | undefined,
  location: string,
): PlaceChoice | undefined =>
  choice !== undefined &&
  (same(choice.text, location) ||
    choice.candidates.some((candidate) => same(candidate.geo.source, location)))
    ? choice
    : undefined;

/**
 * The candidate the form holds now: the location reads its text and the
 * pin is its (`geo`, the coordinates the form vouches for — none, and no
 * candidate is held, whatever the text says).
 */
export const pickedCandidate = (
  choice: PlaceChoice,
  location: string,
  geo: GeoLocation | undefined,
): PlaceCandidate | undefined =>
  geo === undefined
    ? undefined
    : choice.candidates.find(
        (candidate) =>
          same(candidate.geo.source, location) &&
          candidate.geo.lat === geo.lat &&
          candidate.geo.lng === geo.lng,
      );

/** Whether the form holds the text as said with no place for it. */
export const readsAsSaid = (
  choice: PlaceChoice,
  location: string,
  geo: GeoLocation | undefined,
): boolean => same(choice.text, location) && pickedCandidate(choice, location, geo) === undefined;

/**
 * What a turn's candidates come to: the best one that resembles the
 * text is taken (`preselectedPlace`), and the choice stays whenever
 * there is anything at all — a lone taken place too, so the text as
 * said is one chip away — and is nothing for a text nobody knows.
 */
export const settlePlace = (
  change: PlaceChange,
): { readonly choice?: PlaceChoice; readonly taken?: PlaceCandidate } => {
  const taken = preselectedPlace(change.candidates);
  const choice =
    change.candidates.length > 0 ? { candidates: change.candidates, text: change.text } : undefined;
  return { ...(choice ? { choice } : {}), ...(taken ? { taken } : {}) };
};
