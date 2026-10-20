import {
  type GeoLocation,
  geoMatches,
  isMappableLocation,
  normalizeLocationKey,
} from '@calendar/core';

/**
 * Whether the location reads the text kept "as said" — the user declined
 * the places found for it (`keepLocationText`), so it has no pin and
 * none is looked up for it. Kept with the draft (`DraftExtras.
 * locationAsSaid`): a turn that leaves the text alone re-gives it to the
 * form, and so does coming back to the draft.
 */
export const keptAsSaid = (asSaid: string, location: string): boolean =>
  asSaid !== '' && normalizeLocationKey(asSaid) === normalizeLocationKey(location);

/**
 * The text to look up for the map without a pick: the one the editor
 * was given (opened with, or a phrase set) while the field still reads
 * it and holds no coordinates for it. Never a text typed by hand (the
 * picker geocodes), never one kept as said.
 */
export const locationToLookUp = ({
  asSaid,
  geo,
  given,
  location,
}: {
  readonly asSaid: string;
  readonly geo: GeoLocation | undefined;
  readonly given: string;
  readonly location: string;
}): string =>
  location === given &&
  !geoMatches(geo, location) &&
  isMappableLocation(location) &&
  !keptAsSaid(asSaid, location)
    ? location
    : '';

/**
 * The latest word on the place, for a pick whose answer comes late: a
 * typeahead pick resolves its coordinates after an await, and a chip or
 * "As said" pressed meanwhile has said otherwise — the same text, maybe,
 * but no pin — so the answer counts only while the pick is still the
 * last word.
 */
export const latestWord = () => {
  let spoken = 0;
  return {
    /** A new word: the number `stands` recognizes it by. */
    speak: () => {
      spoken += 1;
      return spoken;
    },
    stands: (word: number) => word === spoken,
  };
};
