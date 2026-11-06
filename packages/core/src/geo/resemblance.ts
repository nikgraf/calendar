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

/** An address cut at its commas, each part as its words. */
const partsOf = (address: string | undefined): ReadonlyArray<ReadonlyArray<string>> =>
  (address ?? '')
    .split(',')
    .map(wordsOf)
    .filter((part) => part.length > 0);

const sameWords = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((word, at) => word === b[at]);

/** Whether a part of an address holds a number: a house number, a postal code. */
const numbered = (part: ReadonlyArray<string>): boolean => part.some((word) => NUMBERED.test(word));

/** A place's address, read as which place it is and where it is. */
interface ReadAddress {
  /** A city, a region or a country: the first part is its name, and no part holds a number. */
  readonly locality: boolean;
  /** The part that says which place it is: its street, or its own name. Empty when none does. */
  readonly street: ReadonlyArray<string>;
  /** The parts that say where it is: postal code and city, region, country. */
  readonly where: ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * The first part of an address says which place it is — its street
 * ("Zollergasse 5"), or for a city or a street its own name ("Vienna,
 * Austria", "Kaffeeweg, 1140 Vienna") — when it reads as the place's
 * name, when the text says a number it holds, when a postal code follows
 * it ("Wollzeile 5, 1010 Wien", "Corner Herrengasse / Strauchgasse, 1010
 * Vienna"), or when it holds a house number and more than one part
 * follows ("66 Mint St, San Francisco, CA"). Else every part says where:
 * "1070 Vienna, Austria" after a café's name is its district and city,
 * "Cupertino, CA, United States" after "1 Infinite Loop" its city, state
 * and country.
 */
const readAddress = (place: PlaceLike, said: ReadonlyArray<string>): ReadAddress => {
  const parts = partsOf(place.address);
  const [first = [], second = [], ...rest] = parts;
  const named = first.length > 0 && sameWords(first, wordsOf(place.name ?? ''));
  const isStreet =
    named ||
    first.some((word) => NUMBERED.test(word) && said.includes(word)) ||
    numbered(second) ||
    (rest.length > 0 && numbered(first));
  return {
    locality: named && !parts.some(numbered),
    street: isStreet ? first : [],
    where: isStreet ? parts.slice(1) : parts,
  };
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
 * A word of its own is one of its name or street (`readAddress`) that
 * the parts saying where it is do not hold too: "Vienna, Austria" names
 * the city, not a place that stands in it — every address there ends in
 * those words, and so do names like "Hotel Sacher Vienna".
 */
export const placeMatch = (text: string, place: PlaceLike): PlaceMatch | undefined => {
  const said = wordsOf(text);
  if (said.length === 0) {
    return undefined;
  }
  const name = wordsOf(place.name ?? '');
  const { street, where } = readAddress(place, said);
  const around = where.flat();
  const own = [...name, ...street, ...around];
  // A text that only says where the place is names the city, not the
  // place — by its words, its sound ("Vienna Austria Temple"), or a name
  // that is the same words (a business called "Vienna Austria").
  if (said.every((word) => among(word, around))) {
    return undefined;
  }
  if (name.length > 0 && sameWords(said, name)) {
    return 'exact';
  }
  // A number names a building: it must be there as it is ("Wollzeile 5"
  // is neither Wollzeile 6 nor Wollzeile 50, "12a" not 13a), whatever
  // the words do.
  const numbers = said.filter((word) => NUMBERED.test(word));
  if (!numbers.every((number) => own.includes(number))) {
    return undefined;
  }
  const itsOwn = (word: string): boolean =>
    (among(word, name) || among(word, street)) && !among(word, around);
  if (said.every((word) => among(word, own)) && said.some(itsOwn)) {
    return 'words';
  }
  return soundsLike(said, name) ? 'phonetic' : undefined;
};

/** Letters a part needs to say where: a state's code ("IN", "OR", "CA") is a word of a name as often. */
const WHERE_MIN = 3;

/**
 * Whether the text says where the place is: it holds every word of a
 * part of the address that says where ("Hotel Adlon Berlin" for "…, 10117
 * Berlin, Germany"), or for a city its name ("Linz"). Such a place is the
 * one meant however far it is from the user's own places. One word of a
 * part is not enough: "Royal Cafe" is not in Royal Oak, nor "New Moon
 * Cafe" in New York.
 */
export const saysWhere = (text: string, place: PlaceLike): boolean => {
  const said = wordsOf(text);
  const { locality, street, where } = readAddress(place, said);
  return [...(locality ? [street] : []), ...where].some((part) => {
    const letters = part.filter((word) => !NUMBERED.test(word));
    return letters.join('').length >= WHERE_MIN && letters.every((word) => said.includes(word));
  });
};

/** The first part of an address as one key: its words run together, its numbers kept apart. */
const streetKey = (address: string | undefined): string =>
  (partsOf(address)[0] ?? []).map((word) => (NUMBERED.test(word) ? `|${word}|` : word)).join('');

/**
 * Whether two addresses begin with the same street and number, whatever
 * MapKit abbreviated ("Philharmonikerstraße 4" and "Philharmoniker Str.
 * 4") or wrote in another language after it ("1070 Wien, Österreich"):
 * the words run together, the numbers kept apart ("1-2-34" is not
 * "1-23-4").
 */
export const sameStreet = (a: string | undefined, b: string | undefined): boolean =>
  streetKey(a) === streetKey(b);
