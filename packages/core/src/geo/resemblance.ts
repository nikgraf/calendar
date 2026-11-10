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
  /**
   * The address begins with the place's name: a city ("Vienna, Austria",
   * "4830 Hallstatt, Austria", "Toronto ON, Canada") or a street. Its
   * name is its own wherever else the address repeats it ("Vienna,
   * Vienna, Austria"), and naming it says where it is.
   */
  readonly named: boolean;
  /** The part that says which place it is: its street, or its own name. Empty when none does. */
  readonly street: ReadonlyArray<string>;
  /** The parts that say where it is: postal code and city, region, country. */
  readonly where: ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * The first part of an address says which place it is — its street
 * ("Zollergasse 5"), or for a city or a street its own name — when it
 * begins with the place's name (a postal code before it aside), when the
 * text says a number it holds ("Wollzeile 5"), or when it holds a house
 * number and a postal code or more parts follow ("Wollzeile 5, 1010
 * Wien", "66 Mint St, San Francisco, CA"). Else every part says where:
 * "1070 Vienna, Austria" after a café's name is its district and city,
 * "Mountain View, CA 94043, USA" after "1600 Amphitheatre Pkwy" its city,
 * state and country.
 */
const readAddress = (place: PlaceLike, said: ReadonlyArray<string>): ReadAddress => {
  const parts = partsOf(place.address);
  const [first = [], second = []] = parts;
  const name = wordsOf(place.name ?? '');
  const lettered = first.filter((word) => !NUMBERED.test(word));
  const named = name.length > 0 && sameWords(lettered.slice(0, name.length), name);
  const isStreet =
    named ||
    first.some((word) => NUMBERED.test(word) && said.includes(word)) ||
    (numbered(first) && (numbered(second) || parts.length >= 3));
  return {
    named,
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
 * Whether the text sounds like the whole name, not only its leading
 * words: word by word, or with the words run together.
 */
const soundsWhole = (said: ReadonlyArray<string>, name: ReadonlyArray<string>): boolean => {
  const key = koelnerKey(said.join(' '));
  if (key === '') {
    return false;
  }
  if (key === koelnerKey(name.join(' '))) {
    return true;
  }
  const joined = koelnerKey(said.join(''));
  return joined.length >= JOINED_KEY_MIN && joined === koelnerKey(name.join(''));
};

/**
 * How a place resembles a text, best first: `exact` — its name is the
 * text; `words` — each word of the text begins a word of its name or
 * address ("Figlmüller" for Figlmüller Bäckerstrasse, "Wollzeile 5"),
 * one of them a word of its own; `phonetic` — the text sounds like the
 * name's first words, or, the words that say where the place is set
 * aside, like the whole name ("Cafe Meek, Vienna"); else undefined, and
 * the place is not what the text names.
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
  const { named, street, where } = readAddress(place, said);
  // A place named in its own address (a city, a street) holds its name
  // wherever the address repeats it ("Vienna, Vienna, Austria").
  const around = where.flat().filter((word) => !(named && name.includes(word)));
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
  // The words that say where it is are not the name's to sound like:
  // "Cafe Meek, Vienna" is Kaffemik in Vienna as "Cafe Meek" is. With a
  // where beside it the rest must be the whole name, though: "Kaffee,
  // Wien" is no Café Central.
  const called = said.filter((word) => !around.includes(word));
  const calledName = name.filter((word) => !around.includes(word));
  return soundsLike(said, name) ||
    (called.length > 0 &&
      called.length < said.length &&
      soundsWhole(called, calledName.length > 0 ? calledName : name))
    ? 'phonetic'
    : undefined;
};

/** Words shorter than this say nothing of where: "IN", "de", "le" are words of names as often. */
const WHERE_MIN = 3;

/** A state's, province's or country's code as an address writes it: capitals, two or three ("CA", "NSW", "QC"). */
const CODE = /\b[A-Z]{2,3}\b/g;

/**
 * Whether the text says where the place is: it holds every word of a
 * part of the address that says where, codes aside ("Hotel Adlon Berlin"
 * for "…, 10117 Berlin, Germany", "Opera Bar Sydney" for "Sydney NSW
 * 2000"), or names a city on its own ("Linz"). Such a place is the one
 * meant however far it is from the user's own places. One word of a part
 * is not enough ("Royal Cafe" is not in Royal Oak, nor "New Moon Cafe"
 * in New York), and a name that holds its city says nothing beside the
 * name ("Chicago Grill", said in Vienna) — until a comma sets the where
 * apart ("Chicago Grill, Chicago", "Hard Rock Cafe, Berlin").
 */
export const saysWhere = (text: string, place: PlaceLike): boolean => {
  const said = wordsOf(text);
  const { named, street, where } = readAddress(place, said);
  // A name that holds its city is all name — unless the text sets the
  // where apart after a comma ("Hard Rock Cafe, Berlin" for Hard Rock
  // Cafe Berlin): then only those words are held to the address.
  const nameOnly = !named && sameWords(said, wordsOf(place.name ?? ''));
  const comma = text.indexOf(',');
  if (nameOnly && comma === -1) {
    return false;
  }
  const heard = nameOnly ? wordsOf(text.slice(comma + 1)) : said;
  const codes = new Set(wordsOf((place.address ?? '').match(CODE)?.join(' ') ?? ''));
  return [...(named ? [street] : []), ...where].some((part) => {
    const words = part.filter(
      (word) => !NUMBERED.test(word) && word.length >= WHERE_MIN && !codes.has(word),
    );
    return words.length > 0 && words.every((word) => heard.includes(word));
  });
};

/** The first part of an address as one key: its words run together, its numbers kept apart. */
const streetKey = (address: string | undefined): string =>
  (partsOf(address)[0] ?? []).map((word) => (NUMBERED.test(word) ? `|${word}|` : word)).join('');

/**
 * Whether two addresses are one: the same street and number, whatever
 * MapKit abbreviated ("Philharmonikerstraße 4" and "Philharmoniker Str.
 * 4"), the numbers kept apart ("1-2-34" is not "1-23-4"), and where both
 * say more, the same town — a postal code in common where both have one,
 * else a word of the town's part ("1070 Vienna, Austria" and "1070 Wien,
 * Österreich" are one town; "2340 Mödling, Austria" and "2500 Baden,
 * Austria" two, "Boston" and "New York" two).
 */
export const sameAddress = (a: string | undefined, b: string | undefined): boolean => {
  if (streetKey(a) !== streetKey(b)) {
    return false;
  }
  const restA = partsOf(a).slice(1);
  const restB = partsOf(b).slice(1);
  if (restA.length === 0 || restB.length === 0) {
    return true;
  }
  const codesA = restA.flat().filter((word) => NUMBERED.test(word));
  const codesB = restB.flat().filter((word) => NUMBERED.test(word));
  if (codesA.length > 0 && codesB.length > 0) {
    return codesA.some((code) => codesB.includes(code));
  }
  return (restA[0] ?? []).some((word) => (restB[0] ?? []).includes(word));
};
