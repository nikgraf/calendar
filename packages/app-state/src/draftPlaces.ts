import type { PossiblePlace, QuickAddPrefill } from '@calendar/ai';
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
  /** Where the text was a name taken out of the title (`PlaceTitles`). */
  readonly titles?: PlaceTitles | undefined;
}

/**
 * The two titles of a draft whose place was a name in its phrase's
 * title ("Dinner at Luigi's"): as the words made it, and as it reads
 * with the name in the location field ("Dinner"). "As said" gives the
 * first back (`placeAsSaid`).
 */
export interface PlaceTitles {
  readonly asSaid: string;
  readonly placed: string;
}

/** What a turn found for the location text it set. */
export interface PlaceChange {
  readonly candidates: ReadonlyArray<PlaceCandidate>;
  /** The text the turn put in the location. */
  readonly text: string;
  /** Set where the text left the title for the location (a possible place the lookup proved). */
  readonly titles?: PlaceTitles | undefined;
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
    change.candidates.length > 0
      ? {
          candidates: change.candidates,
          text: change.text,
          ...(change.titles ? { titles: change.titles } : {}),
        }
      : undefined;
  return { ...(choice ? { choice } : {}), ...(taken ? { taken } : {}) };
};

/**
 * What "As said" puts in the form: the location text as the words said
 * it, with no place for it. Where the text was a name the lookup took
 * out of the title ("Dinner at Luigi's" became "Dinner" at Luigi's), as
 * said is the title with the name in it and no location — the one way
 * back from a place that was none ("Spaziergang im Mondschein") — as
 * long as the title still reads what the lookup left; edited by hand
 * since, it stays, and the name goes to the location as text, so no
 * word is lost either way.
 */
export const placeAsSaid = (
  choice: PlaceChoice,
  title: string,
): { readonly location: string; readonly title?: string } =>
  choice.titles !== undefined && title === choice.titles.placed
    ? { location: '', title: choice.titles.asSaid }
    : { location: choice.text };

/**
 * The words "As said" would give back, for its chip to name: the title
 * with the name in it where that is what comes back ("Dinner at
 * Luigi's"), else the location text ("Luigi's").
 */
export const asSaidLabel = (choice: PlaceChoice, title: string): string =>
  placeAsSaid(choice, title).title ?? choice.text;

/**
 * What the thread looks up for a first phrase: the place it names, or
 * the name it may mean as one — asked as `possible`, so it is answered
 * only with proof.
 */
export const placeToLookUp = (
  location: string | undefined,
  possible: PossiblePlace | undefined,
): { readonly possible: boolean; readonly text: string | undefined } =>
  location === undefined && possible !== undefined
    ? { possible: true, text: possible.place }
    : { possible: false, text: location };

/**
 * A first phrase's draft once the lookup has answered for its possible
 * place — a name the words end in that nothing calls a place ("… im
 * Figlmüller", "at Luigi's"). The lookup answers such a name only with
 * proof (`placeCandidates` with `possible`: a past place written exactly
 * that, or a nearby venue called exactly that, the proof first). With
 * proof the name becomes the draft's place and leaves its title, and
 * the candidates go on as any place's do: the first is taken, the rest
 * stay to pick from (`settlePlace`), and "As said" gives the title its
 * words back (`placeAsSaid`). With none — no such place, a lookup that
 * failed or ran out of time — the draft is the phrase's as it was: the
 * words in the title, no place, nothing to choose. Without a possible
 * place, or where the prefill has a place of its own, the prefill and
 * what was found for its location.
 */
export const settlePossiblePlace = (
  prefill: QuickAddPrefill,
  possible: PossiblePlace | undefined,
  found: PlaceChange | undefined,
): { readonly place: PlaceChange | undefined; readonly prefill: QuickAddPrefill } => {
  if (possible === undefined || prefill.location !== undefined) {
    return { place: found, prefill };
  }
  if (found === undefined || preselectedPlace(found.candidates) === undefined) {
    return { place: undefined, prefill };
  }
  // The title held the name only where the model kept it there: one
  // that cut it off (Apple's on the Mac) left nothing to give back.
  const titles =
    prefill.title === possible.title
      ? {}
      : { titles: { asSaid: prefill.title, placed: possible.title } };
  return {
    place: { candidates: found.candidates, text: possible.place, ...titles },
    prefill: { ...prefill, location: possible.place, title: possible.title },
  };
};
