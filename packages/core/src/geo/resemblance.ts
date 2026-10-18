import { foldSearchText } from '../search/match.ts';
import { koelnerKey } from './phonetic.ts';

/**
 * Whether a place MapKit returned is the place a text names. A search
 * answers something for almost any text — "Room 4" found "Am Rahm 4" in
 * Weidling, "the office" a bar — so a hit counts only when its name (or
 * address) resembles the words: the same name, every word of the text
 * beginning one of the place's, or the same sound (`koelnerKey`) as the
 * name's leading words, which is what a dictated "Cafe Zentral" needs to
 * be Café Central.
 */

/** What a resolved place says of itself: MapKit's name and address. */
export interface PlaceLike {
  readonly address?: string | undefined;
  readonly name?: string | undefined;
}

export type PlaceMatch = 'exact' | 'phonetic' | 'words';

/**
 * Street words as MapKit abbreviates them in an address ("66 Mint St"
 * for a typed "66 Mint Street"): both sides read the short form.
 */
const SHORT_FORMS: ReadonlyMap<string, string> = new Map([
  ['avenue', 'ave'],
  ['boulevard', 'blvd'],
  ['court', 'ct'],
  ['drive', 'dr'],
  ['gasse', 'g'],
  ['lane', 'ln'],
  ['place', 'pl'],
  ['platz', 'pl'],
  ['road', 'rd'],
  ['square', 'sq'],
  ['str', 'str'],
  ['strasse', 'str'],
  ['street', 'st'],
  ['terrace', 'ter'],
]);

/** German glues the street word on ("Hauptstraße", "Hauptstr."): the same short form. */
const GLUED_STREET = /(?:strasse|str)$/;

const wordsOf = (text: string): ReadonlyArray<string> =>
  foldSearchText(text)
    .replaceAll('ß', 'ss')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '')
    .map((word) => SHORT_FORMS.get(word) ?? word.replace(GLUED_STREET, 'str'));

const NUMBER = /^\p{N}+$/u;

/**
 * How a place resembles a text, best first: `exact` — its name is the
 * text; `words` — each word of the text begins a word of its name or
 * address ("Figlmüller" for Figlmüller Bäckerstrasse, "Wollzeile 5");
 * `phonetic` — the text sounds like the name's first words; else
 * undefined, and the place is not what the text names.
 */
export const placeMatch = (text: string, place: PlaceLike): PlaceMatch | undefined => {
  const said = wordsOf(text);
  if (said.length === 0) {
    return undefined;
  }
  const name = wordsOf(place.name ?? '');
  const own = [...name, ...wordsOf(place.address ?? '')];
  if (name.length > 0 && said.join(' ') === name.join(' ')) {
    return 'exact';
  }
  // A number names a building: it must be there as it is ("Wollzeile 5"
  // is neither Wollzeile 6 nor Wollzeile 50), whatever the words do.
  const numbers = said.filter((word) => NUMBER.test(word));
  if (!numbers.every((number) => own.includes(number))) {
    return undefined;
  }
  if (said.every((word) => NUMBER.test(word) || own.some((part) => part.startsWith(word)))) {
    return 'words';
  }
  const key = koelnerKey(said.join(' '));
  if (
    key !== '' &&
    name.length >= said.length &&
    koelnerKey(name.slice(0, said.length).join(' ')) === key
  ) {
    return 'phonetic';
  }
  return undefined;
};

/** The places that resemble the text, best first, their order kept among equals. */
export const placesResembling = <Place extends PlaceLike>(
  text: string,
  places: ReadonlyArray<Place>,
): ReadonlyArray<Place> => {
  const rank: Record<PlaceMatch, number> = { exact: 0, phonetic: 2, words: 1 };
  return places
    .flatMap((place, index) => {
      const match = placeMatch(text, place);
      return match === undefined ? [] : [{ index, place, rank: rank[match] }];
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.place);
};
