import { foldSearchText } from '@calendar/core';
import {
  defersDate,
  durationMinutesOf,
  groundDate,
  isAllDayPhrase,
  mentionsDate,
  namedWeekdays,
  periodOf,
  saysOnlyWhen,
  statedRepeat,
  statedTimes,
} from './grounding.ts';
import type { QuickAddPrefill } from './normalizeQuickAdd.ts';

/**
 * A turn that is one bare phrase leaning on the draft: only where its
 * place is ("it's in Vienna", "the one in Berlin", "es ist in Wien"), or
 * only who it is with ("with Stefan", "mit Anna"). A model asked for the
 * whole event back answers such a turn its own way each time — Apple's
 * put "Vienna" over "Cafe Meek" or changed nothing, and wrote "with
 * Stefan" into the location — so the code reads these words alone and no
 * model is asked. Where says more of the place the draft has ("Cafe
 * Meek, Vienna", which the place lookup reads as a name and where it
 * is); company joins the title, as in a first phrase, and invites no one.
 */

/** What the thread knows of a draft beyond its prefill. */
export interface TurnContext {
  /**
   * The draft's place as the words said it, where a lookup or a pick
   * wrote the location over it ("Hard Rock Cafe" for "Hard Rock Cafe,
   * Rotenturmstraße 25, 1010 Vienna, Austria").
   */
  readonly placeSaid?: string | undefined;
  /** The thread's words before this turn, oldest first. */
  readonly said?: ReadonlyArray<string> | undefined;
}

/** Lower-case, accent-free text with straight apostrophes and "ss" for ß. */
const fold = (text: string): string =>
  foldSearchText(text)
    .replaceAll(/[‘’`]/g, "'")
    .replaceAll('ß', 'ss');

/** A word as said, and folded without the punctuation around it. */
interface Word {
  readonly plain: string;
  readonly text: string;
}

const EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

const wordsOf = (utterance: string): ReadonlyArray<Word> =>
  utterance
    .trim()
    .split(/\s+/u)
    .map((text) => ({ plain: fold(text).replaceAll(EDGES, ''), text }))
    .filter(({ plain }) => plain !== '');

/** The words as said, without the quotes and the punctuation a sentence puts around them. */
const textOf = (words: ReadonlyArray<Word>): string =>
  words
    .map(({ text }) => text)
    .join(' ')
    .replaceAll(/^[\s"'“”‘’„«»(]+|[\s"'“”‘’«».,;:!?…)]+$/gu, '');

/** Word sequences, the longest first, so "it is located" is read before "it is". */
const sequences = (...phrases: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> =>
  phrases.map((phrase) => phrase.split(' ')).sort((a, b) => b.length - a.length);

/** How many words the longest of `among` that stands at `at` takes; 0 for none. */
const lengthAt = (
  words: ReadonlyArray<Word>,
  at: number,
  among: ReadonlyArray<ReadonlyArray<string>>,
): number =>
  among.find((sequence) => sequence.every((word, index) => words[at + index]?.plain === word))
    ?.length ?? 0;

/** A word a correction opens with ("no, in Vienna", "sorry, the one in Berlin"). */
const OPENERS = sequences('no', 'nope', 'nein', 'actually', 'sorry', 'oh', 'eigentlich');

/** "The one …": one of several places of the name, told apart by where it is. */
const SELECTORS = sequences(
  'the one',
  'i mean the one',
  'i meant the one',
  "it's the one",
  "that's the one",
  'ich meine das',
  'ich meine den',
  'ich meine die',
  'ich meine der',
  'das',
  'der',
  'die',
  'den',
);

/** What leads from "the one" into where it is. */
const SELECTOR_LINKS = sequences(
  'in',
  'on',
  'at',
  'near',
  'by',
  'next to',
  'close to',
  'im',
  'am',
  'bei',
  'beim',
  'an',
  'auf',
  'neben',
  'nahe',
);

/** "It's in …": the place the draft has, said to be somewhere. */
const FRAMES = sequences(
  "it's",
  'its',
  'it is',
  'is',
  "that's",
  'thats',
  'that is',
  "it's located",
  'it is located',
  'es ist',
  'das ist',
  'es liegt',
  'liegt',
  'ist',
);

const DETERMINERS = new Set([
  'a',
  'an',
  'das',
  'dem',
  'den',
  'der',
  'die',
  'einem',
  'einer',
  'meinem',
  'meiner',
  'my',
  'our',
  'the',
  'unserem',
  'unserer',
]);

/**
 * Words no city's or district's name is made of here: with one of them
 * the words say more than where ("in front of the opera", "in honor of
 * Anna", "in the office") and the model reads the turn as before.
 */
const NOT_OF_A_NAME = new Set([
  'a',
  'als',
  'an',
  'and',
  'as',
  'at',
  'bei',
  'by',
  'das',
  'dem',
  'den',
  'der',
  'des',
  'die',
  'ein',
  'eine',
  'einem',
  'einer',
  'eines',
  'es',
  'for',
  'from',
  'fur',
  'her',
  'his',
  'instead',
  'is',
  'ist',
  'it',
  'mit',
  'my',
  'nicht',
  'not',
  'oder',
  'of',
  'ohne',
  'or',
  'our',
  'statt',
  'stattdessen',
  'that',
  'the',
  'their',
  'these',
  'this',
  'those',
  'to',
  'und',
  'von',
  'with',
  'without',
  'your',
  'zu',
]);

/**
 * What follows "in" and is no place: how it is held ("in person", "in
 * Präsenz", "in English", "in groups"), an app it is held in ("in
 * Teams"), a state or a saying ("in Ordnung", "in progress", "in
 * Urlaub"), a season. German writes every noun with a capital and a
 * typed turn often none, so the letters do not tell a name: this list
 * does.
 */
const NOT_A_PLACE = new Set([
  'absprache',
  'abstimmung',
  'abwesenheit',
  'addition',
  'advance',
  'anwesenheit',
  'arbeit',
  'autumn',
  'bearbeitung',
  'bed',
  'begleitung',
  'between',
  'black',
  'blue',
  'brief',
  'bulk',
  'case',
  'cash',
  'character',
  'charge',
  'church',
  'class',
  'color',
  'colour',
  'common',
  'conclusion',
  'costume',
  'court',
  'detail',
  'deutsch',
  'discord',
  'doubt',
  'echt',
  'effect',
  'eile',
  'elternzeit',
  'englisch',
  'english',
  'essence',
  'facetime',
  'fact',
  'fall',
  'farbe',
  'frage',
  'french',
  'fruhling',
  'full',
  'future',
  'gedanken',
  'general',
  'german',
  'gesellschaft',
  'green',
  'groups',
  'gruppen',
  'half',
  'hand',
  'herbst',
  'house',
  'ink',
  'italian',
  'karenz',
  'kind',
  'kopie',
  'kurze',
  'line',
  'love',
  'meet',
  'mind',
  'order',
  'ordnung',
  'pairs',
  'parallel',
  'particular',
  'pencil',
  'person',
  'place',
  'planung',
  'play',
  'practice',
  'prasenz',
  'principle',
  'private',
  'progress',
  'public',
  'quarantane',
  'question',
  'raten',
  'red',
  'rente',
  'reverse',
  'ruhe',
  'school',
  'secret',
  'session',
  'shifts',
  'short',
  'sicht',
  'silence',
  'skype',
  'slack',
  'sommer',
  'spanish',
  'spring',
  'stereo',
  'stock',
  'store',
  'sum',
  'summe',
  'summer',
  'sync',
  'teams',
  'teilzeit',
  'theory',
  'time',
  'total',
  'touch',
  'town',
  'transit',
  'trouble',
  'turn',
  'uniform',
  'urlaub',
  'use',
  'vain',
  'vertretung',
  'view',
  'vollzeit',
  'vorbereitung',
  'wahrheit',
  'webex',
  'white',
  'winter',
  'wirklichkeit',
  'writing',
  'zivil',
  'zoom',
  'zukunft',
]);

/** Words of a where at most: "Stratford upon Avon", "the one on Mariahilfer Straße". */
const WHERE_WORDS = 4;

const DIGIT = /\p{N}/u;

/**
 * Whether the words say anything of when: a day, a time, a length, a
 * repeat. "The one on Friday" picks a day and "in March" a month, never
 * a place.
 */
const saysWhen = (utterance: string, rest: string): boolean =>
  saysOnlyWhen(rest) ||
  namedWeekdays(utterance).length > 0 ||
  // Any day will do to hear "tomorrow" or "heute": only whether one is named counts.
  groundDate(undefined, { phrase: utterance, referenceDate: '2026-01-01' }) !== undefined ||
  mentionsDate(utterance) ||
  defersDate(utterance) ||
  periodOf(utterance) !== undefined ||
  statedTimes(utterance).start !== undefined ||
  durationMinutesOf(utterance) !== undefined ||
  isAllDayPhrase(utterance) ||
  statedRepeat(utterance) !== undefined;

/** Whether the words name a place and nothing else: a few words, none a function word, the first no number. */
const namesWhere = (name: ReadonlyArray<Word>): boolean => {
  const [first] = name;
  return (
    first !== undefined &&
    name.length <= WHERE_WORDS &&
    !DIGIT.test(first.plain) &&
    !NOT_A_PLACE.has(first.plain) &&
    name.every(({ plain }) => !NOT_OF_A_NAME.has(plain))
  );
};

/**
 * Where a turn says the draft's place is, when that is all it says: "the
 * one" and what leads to where ("the one in Berlin", "the one on
 * Mariahilfer Straße", "das beim Bahnhof"), or "in" and a bare name with
 * or without "it's" before it ("it's in Vienna", "in Neubau", "es ist in
 * Wien"). "In the office" and "im Büro" name a venue of their own, "at
 * Café Central" another place, "in Vienna instead" a replacement: those
 * are the model's to read, as before.
 */
export const whereOf = (utterance: string): string | undefined => {
  const words = wordsOf(utterance);
  const from = lengthAt(words, 0, OPENERS);
  const selector = lengthAt(words, from, SELECTORS);
  const link = selector === 0 ? 0 : lengthAt(words, from + selector, SELECTOR_LINKS);
  let name: ReadonlyArray<Word>;
  if (link > 0) {
    const rest = words.slice(from + selector + link);
    name = rest[0] !== undefined && DETERMINERS.has(rest[0].plain) ? rest.slice(1) : rest;
  } else {
    const at = from + lengthAt(words, from, FRAMES);
    if (words[at]?.plain !== 'in') {
      return undefined;
    }
    name = words.slice(at + 1);
    // A bare name has no number: "in 2 hours" and "in Room 4" say other things.
    if (name.some(({ plain }) => DIGIT.test(plain))) {
      return undefined;
    }
  }
  const where = textOf(name);
  return namesWhere(name) && where !== '' && !saysWhen(utterance, where) ? where : undefined;
};

/** What "with" leads into that is no company: a notification, a note, a call's link. */
const NOT_COMPANY = new Set([
  'alarm',
  'alarms',
  'alert',
  'alerts',
  'benachrichtigung',
  'benachrichtigungen',
  'erinnerung',
  'erinnerungen',
  'facetime',
  'hinweis',
  'link',
  'meet',
  'no',
  'note',
  'notes',
  'notification',
  'notifications',
  'notiz',
  'notizen',
  'pleasure',
  'reminder',
  'reminders',
  'skype',
  'teams',
  'video',
  'wecker',
  'zoom',
]);

/** Words after which the turn says more than who: a place, another change. */
const ENDS_COMPANY = new Set([
  'aber',
  'am',
  'at',
  'bei',
  'beim',
  'but',
  'dann',
  'im',
  'in',
  'instead',
  'nicht',
  'not',
  'on',
  'statt',
  'stattdessen',
  'then',
  'to',
  'um',
]);

/** What a company turn may open with ("and with Stefan", "auch mit Anna"). */
const COMPANY_FRAMES = sequences("it's", 'its', 'it is', 'and', 'also', 'es ist', 'und', 'auch');

/** Words of a company at most: "with Stefan and Anna from accounting". */
const COMPANY_WORDS = 6;

/**
 * Who a turn says the event is with, when that is all it says ("with
 * Stefan", "with the team", "mit Anna und Tom"): the linking word as the
 * title takes it, and the company as said.
 */
export const companyOf = (
  utterance: string,
): { readonly company: string; readonly link: 'mit' | 'with' } | undefined => {
  const words = wordsOf(utterance);
  const from = lengthAt(words, 0, OPENERS);
  const at = from + lengthAt(words, from, COMPANY_FRAMES);
  const link = words[at]?.plain;
  if (link !== 'with' && link !== 'mit') {
    return undefined;
  }
  const rest = words.slice(at + 1);
  const named = rest[0] !== undefined && DETERMINERS.has(rest[0].plain) ? rest.slice(1) : rest;
  const company = textOf(rest);
  const [first] = named;
  return first !== undefined &&
    rest.length <= COMPANY_WORDS &&
    !NOT_COMPANY.has(first.plain) &&
    rest.every(({ plain }) => !DIGIT.test(plain) && !ENDS_COMPANY.has(plain)) &&
    company !== '' &&
    !saysWhen(utterance, company)
    ? { company, link }
    : undefined;
};

const lettersOf = (text: string): ReadonlyArray<string> =>
  fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');

/** Whether `text` holds every word of `words` as a word of its own. */
const holdsWords = (text: string, words: string): boolean => {
  const held = new Set(lettersOf(text));
  const wanted = lettersOf(words);
  return wanted.length > 0 && wanted.every((word) => held.has(word));
};

/**
 * Whether the location says that where already: after its first comma,
 * where an address says where a place is ("Cafe Meek, Vienna", "…, 1010
 * Vienna, Austria"). A name that holds its city says nothing ("Vienna
 * Cafe" may stand in Graz).
 */
const saysWhere = (location: string, where: string): boolean => {
  const comma = location.indexOf(',');
  return comma !== -1 && holdsWords(location.slice(comma + 1), where);
};

/** Where `place` stands in the folded `words` as words of its own. */
const occurrencesOf = (words: string, place: string): ReadonlyArray<number> => {
  const found: Array<number> = [];
  for (let from = words.indexOf(place); from !== -1; from = words.indexOf(place, from + 1)) {
    if (
      !/[\p{L}\p{N}]/u.test(words[from - 1] ?? ' ') &&
      !/[\p{L}\p{N}]/u.test(words[from + place.length] ?? ' ')
    ) {
      found.push(from);
    }
  }
  return found;
};

/** "In" and no article before a place: where something is, not a venue ("in Berlin", not "im Café"). */
const SAID_AS_WHERE = /(?:^|[^\p{L}\p{N}])in\s+$/u;

/**
 * Whether the place was itself said as a where: in the latest words that
 * hold it, it follows a bare "in" ("Conference in Berlin", "it's in
 * Berlin"). A where said of such a place is another city, not more of
 * the same one.
 */
const saidAsWhere = (place: string, said: ReadonlyArray<string>): boolean => {
  const key = fold(place).trim();
  for (const earlier of [...said].reverse()) {
    const words = fold(earlier);
    const occurrences = occurrencesOf(words, key);
    if (occurrences.length > 0) {
      return occurrences.some((from) => SAID_AS_WHERE.test(words.slice(0, from)));
    }
  }
  return false;
};

/** The place without the where an earlier turn added to it: a second "it's in …" corrects the first. */
const withoutEarlierWhere = (place: string, said: ReadonlyArray<string>): string => {
  for (const earlier of [...said].reverse()) {
    const where = whereOf(earlier);
    if (where === undefined || where.length >= place.length) {
      continue;
    }
    const lead = place.slice(0, place.length - where.length);
    if (fold(place.slice(lead.length)) === fold(where) && /,\s*$/u.test(lead)) {
      return lead.replace(/,\s*$/u, '');
    }
  }
  return place;
};

/**
 * The draft's location once a turn said where its place is: the where
 * alone for a draft without a place, or over a place that was itself
 * said as a where; nothing new where the location says so already
 * (`saysWhere`); else the place as said and the where after it.
 */
const narrowed = (
  where: string,
  location: string | undefined,
  { placeSaid, said = [] }: TurnContext,
): string => {
  const whole = location?.trim() ?? '';
  if (whole === '') {
    return where;
  }
  if (saysWhere(whole, where)) {
    return whole;
  }
  const base = withoutEarlierWhere(placeSaid?.trim() || whole, said);
  return saidAsWhere(base, said) ? where : `${base}, ${where}`;
};

const COMPANY_IN_TITLE = /(?:^|\s)(?:with|mit)\s/u;

/** The title with the company a turn named: after "with", or joined to the company it has. */
const withCompany = (title: string, link: 'mit' | 'with', company: string): string => {
  if (holdsWords(title, company)) {
    return title;
  }
  return COMPANY_IN_TITLE.test(fold(title))
    ? `${title} ${link === 'mit' ? 'und' : 'and'} ${company}`
    : `${title} ${link} ${company}`;
};

/**
 * The draft as a bare turn leaves it, or undefined for any other turn.
 * A to-do has no place (`places: false`): what its words say of one is
 * the model's to read into its title, as before.
 */
export const bareTurn = (
  utterance: string,
  draft: QuickAddPrefill,
  { places = true, ...context }: TurnContext & { readonly places?: boolean | undefined } = {},
): QuickAddPrefill | undefined => {
  const where = places ? whereOf(utterance) : undefined;
  if (where !== undefined) {
    const location = narrowed(where, draft.location, context);
    return location === draft.location ? draft : { ...draft, location };
  }
  const joined = companyOf(utterance);
  if (joined === undefined) {
    return undefined;
  }
  const title = withCompany(draft.title, joined.link, joined.company);
  return title === draft.title ? draft : { ...draft, title };
};
