import { normalizeLocationKey, type PlaceCandidate, preselectedPlace } from '@calendar/core';

/**
 * The places a turn's location text could mean, left for the user to
 * choose from when none could be taken without asking: the candidates
 * (`placeCandidates`: past places first, then MapKit's matches) and the
 * text as said. A pick makes the place the draft's, pin and all; "keep"
 * leaves the text as it is.
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

/**
 * The choice as it applies to the form now: only while the location
 * still reads the text the candidates were found for. Edited by hand,
 * picked from the typeahead or cleared, the field names something else,
 * and the chips would put the old place over it.
 */
export const livePlaceChoice = (
  choice: PlaceChoice | undefined,
  location: string,
): PlaceChoice | undefined =>
  choice !== undefined && normalizeLocationKey(choice.text) === normalizeLocationKey(location)
    ? choice
    : undefined;

/**
 * What a turn's candidates come to: the one place to take without
 * asking (`preselectedPlace`), else a choice when there is anything to
 * choose from, else nothing — the text stays as said, a room name or a
 * place nobody knows.
 */
export const settlePlace = (
  change: PlaceChange,
): { readonly choice?: PlaceChoice; readonly taken?: PlaceCandidate } => {
  const taken = preselectedPlace(change.candidates);
  if (taken) {
    return { taken };
  }
  return change.candidates.length > 0
    ? { choice: { candidates: change.candidates, text: change.text } }
    : {};
};
