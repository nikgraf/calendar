import { foldSearchText } from '../search/match.ts';
import { koelnerKey } from './phonetic.ts';

/**
 * Whether a place MapKit returned is the place a text names. A search
 * answers something for almost any text — "Room 4" found "Am Rahm 4" in
 * Weidling, "the office" a bar — so a hit counts only when its name (or
 * address) resembles the words: the same name, every word of the text
 * beginning one of the place's with one of them the place's own, or the
 * same sound (`koelnerKey`) as the name's leading words, which is what a
 * dictated "Cafe Zentral" needs to be Café Central.
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
  ['apartment', 'apt'],
  ['avenue', 'ave'],
  ['boulevard', 'blvd'],
  ['building', 'bldg'],
  ['center', 'ctr'],
  ['centre', 'ctr'],
  ['circle', 'cir'],
  ['court', 'ct'],
  ['drive', 'dr'],
  ['expressway', 'expy'],
  ['floor', 'fl'],
  ['freeway', 'fwy'],
  ['gasse', 'g'],
  ['highway', 'hwy'],
  ['lane', 'ln'],
  ['mount', 'mt'],
  ['parkway', 'pkwy'],
  ['place', 'pl'],
  ['platz', 'pl'],
  ['plaza', 'plz'],
  ['road', 'rd'],
  ['saint', 'st'],
  ['square', 'sq'],
  ['str', 'str'],
  ['strasse', 'str'],
  ['street', 'st'],
  ['suite', 'ste'],
  ['terrace', 'ter'],
  ['trail', 'trl'],
  ['turnpike', 'tpke'],
]);

/** German glues the street word on ("Hauptstraße", "Hauptstr."): the same short form. */
const GLUED_STREET = /(?:strasse|str)$/;

const wordsOf = (text: string): ReadonlyArray<string> =>
  foldSearchText(text)
    .replaceAll('ß', 'ss')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '')
    .map((word) => SHORT_FORMS.get(word) ?? word.replace(GLUED_STREET, 'str'));

/** A token with a digit in it names a building or a floor ("5", "12a", "3b"): it must be there as it is. */
const NUMBERED = /\p{N}/u;

/**
 * An address in two parts: its first line (the street and number — or,
 * for a city, the city itself) and what follows the first comma (postal
 * code and city, region, country): where the place is, which it shares
 * with every other place there.
 */
const addressParts = (
  address: string | undefined,
): { readonly around: ReadonlyArray<string>; readonly street: ReadonlyArray<string> } => {
  const [first = '', ...rest] = (address ?? '').split(',');
  return { around: wordsOf(rest.join(',')), street: wordsOf(first) };
};

/** Whether `word` of a text is one of `parts`: a number as it is, a word as a beginning. */
const among = (word: string, parts: ReadonlyArray<string>): boolean =>
  NUMBERED.test(word) ? parts.includes(word) : parts.some((part) => part.startsWith(word));

/** Sounds this short are shared by too many names to tell two apart once the words are joined. */
const JOINED_KEY_MIN = 3;

/**
 * Whether the text sounds like the name's leading words: word by word
 * ("Cafe Zentral" for Café Central), or with the words run together,
 * since dictation cuts a name it does not know into words it does —
 * "Cafe Meek" and "coffee Nick" for Kaffemik.
 */
const soundsLike = (said: ReadonlyArray<string>, name: ReadonlyArray<string>): boolean => {
  const key = koelnerKey(said.join(' '));
  if (key === '') {
    return false;
  }
  if (name.length >= said.length && koelnerKey(name.slice(0, said.length).join(' ')) === key) {
    return true;
  }
  const joined = koelnerKey(said.join(''));
  return (
    joined.length >= JOINED_KEY_MIN &&
    name.some((_, last) => koelnerKey(name.slice(0, last + 1).join('')) === joined)
  );
};

/**
 * How a place resembles a text, best first: `exact` — its name is the
 * text; `words` — each word of the text begins a word of its name or
 * address ("Figlmüller" for Figlmüller Bäckerstrasse, "Wollzeile 5"),
 * one of them a word of its own; `phonetic` — the text sounds like the
 * name's first words; else undefined, and the place is not what the text
 * names.
 *
 * A word of its own is one of its name or street that the rest of its
 * address does not hold too: "Vienna, Austria" names the city, not a
 * place that stands in it — every address there ends in those words, and
 * so do names like "Hotel Sacher Vienna".
 */
export const placeMatch = (text: string, place: PlaceLike): PlaceMatch | undefined => {
  const said = wordsOf(text);
  if (said.length === 0) {
    return undefined;
  }
  const name = wordsOf(place.name ?? '');
  const { around, street } = addressParts(place.address);
  const own = [...name, ...street, ...around];
  if (name.length > 0 && said.join(' ') === name.join(' ')) {
    return 'exact';
  }
  // A number names a building: it must be there as it is ("Wollzeile 5"
  // is neither Wollzeile 6 nor Wollzeile 50, "12a" not 13a), whatever
  // the words do.
  const numbers = said.filter((word) => NUMBERED.test(word));
  if (!numbers.every((number) => own.includes(number))) {
    return undefined;
  }
  // A text that only says where the place is names the city, not the
  // place — by its words or by its sound ("Vienna Austria Temple").
  if (said.every((word) => among(word, around))) {
    return undefined;
  }
  const itsOwn = (word: string): boolean =>
    (among(word, name) || among(word, street)) && !among(word, around);
  if (said.every((word) => among(word, own)) && said.some(itsOwn)) {
    return 'words';
  }
  return soundsLike(said, name) ? 'phonetic' : undefined;
};

/** Shorter words are too often something else: "in" is Indiana's code, "or" Oregon's, "de" Delaware's. */
const WHERE_WORD_MIN = 3;

/**
 * Whether the text says where the place is: one of its words is a word
 * of the place's city, region or country ("Hotel Adlon Berlin"). Such a
 * place is the one meant however far it is from the user's own places.
 */
export const saysWhere = (text: string, place: PlaceLike): boolean => {
  const { around } = addressParts(place.address);
  return wordsOf(text).some(
    (word) => word.length >= WHERE_WORD_MIN && !NUMBERED.test(word) && around.includes(word),
  );
};

/** Whether two addresses read the same, whatever MapKit abbreviated ("Philharmonikerstraße 4" and "Philharmoniker Str. 4"). */
export const sameAddress = (a: string | undefined, b: string | undefined): boolean =>
  wordsOf(a ?? '').join('') === wordsOf(b ?? '').join('');

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
