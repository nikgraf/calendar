import { Contact, Temporal } from '@calendar/core';
import { fold } from '../check.ts';

/**
 * The practice phrases a model is trained on: what a generator is asked
 * to write, and what keeps them apart from the bench's cases. The bench
 * stays the test, so nothing here shows the generator a case (the
 * examples in the prompt are none of the bench's phrases), and a phrase
 * that reads like one is left out (`nearBench`). Follow-ups are short
 * and alike by nature ("make it 9" beside the bench's "make it 8"): the
 * filter keeps those, and a result has to say so.
 */

/**
 * The people and places a batch of phrases may name, and the address book
 * the people are looked up in. The generator writes them itself (`names`
 * step, `NAMES_SCHEMA`), so no name in the data comes from a model whose
 * outputs may not be trained on; a person the bench's books hold is left
 * out (`namesOf`).
 */
export interface Names {
  readonly people: ReadonlyArray<readonly [string, string]>;
  readonly places: ReadonlyArray<string>;
}

export const NAMES_SCHEMA = {
  additionalProperties: false,
  properties: {
    people: {
      items: {
        additionalProperties: false,
        properties: { first: { type: 'string' }, last: { type: 'string' } },
        required: ['first', 'last'],
        type: 'object',
      },
      type: 'array',
    },
    places: { items: { type: 'string' }, type: 'array' },
  },
  required: ['people', 'places'],
  type: 'object',
} as const;

/** What the generator is asked for the names: people and places of ordinary lives. */
export const buildNamesPrompt = (people: number, places: number): string =>
  [
    `Invent ${String(people)} people and ${String(places)} places for practice phrases in a`,
    "calendar app's quick-add box, used by people in Austria, Germany and English-speaking",
    'countries.',
    '- People: a first and a last name each, of many backgrounds (German, Austrian, English,',
    '  Spanish, Turkish, Polish, Japanese, Nigerian, Indian and others), no two alike, none',
    '  famous.',
    '- Places: what people put in a calendar entry: cafés, restaurants, bars, gyms, doctors’',
    '  practices, offices and meeting rooms, schools, stations, parks, a few street addresses',
    '  and cities; in German and in English.',
  ].join('\n');

const textOf = (value: unknown): string =>
  typeof value === 'string' ? value.trim().replaceAll(/\s+/gu, ' ') : '';

/**
 * The generator's names, held to what a phrase can use: no one twice, no
 * one the bench's books hold (by name or by address), no place twice.
 */
export const namesOf = (answer: unknown, benchBook: ReadonlyArray<Contact>): Names => {
  const record = typeof answer === 'object' && answer !== null ? answer : {};
  const people = 'people' in record && Array.isArray(record.people) ? record.people : [];
  const places = 'places' in record && Array.isArray(record.places) ? record.places : [];
  const taken = new Set(
    benchBook.flatMap((contact) => [fold(contact.displayName ?? ''), contact.email.toLowerCase()]),
  );
  const seen = new Set<string>();
  const kept = people.flatMap((person: unknown): Array<readonly [string, string]> => {
    const first = textOf(
      typeof person === 'object' && person !== null && 'first' in person ? person.first : '',
    );
    const last = textOf(
      typeof person === 'object' && person !== null && 'last' in person ? person.last : '',
    );
    const name = fold(`${first} ${last}`);
    const email = emailOf(first, last);
    if (!first || !last || seen.has(name) || taken.has(name) || taken.has(email)) {
      return [];
    }
    seen.add(name);
    return [[first, last]];
  });
  const placeSeen = new Set<string>();
  const keptPlaces = places.flatMap((place: unknown) => {
    const text = textOf(place);
    if (!text || placeSeen.has(fold(text))) {
      return [];
    }
    placeSeen.add(fold(text));
    return [text];
  });
  return { people: kept, places: keptPlaces };
};

const emailOf = (first: string, last: string): string =>
  `${first}.${last}@example.com`.toLowerCase().replaceAll(/[^a-z0-9.@-]/gu, '');

/** The people as an address book, each at a made-up `first.last@example.com`. */
export const bookOf = (people: Names['people']): ReadonlyArray<Contact> =>
  people.map(
    ([first, last], index) =>
      new Contact({
        displayName: `${first} ${last}`,
        email: emailOf(first, last),
        id: `device:${String(index)}:${emailOf(first, last)}`,
        source: 'device',
      }),
  );

export type Language = 'de' | 'en';

const REGISTERS = {
  command:
    'said as a command to the app ("add …", "schedule …", "put … on my calendar", "create an event for …", "trag … ein", "erstelle einen Termin …", "neuer Termin: …")',
  dictated:
    'dictated to a speech recogniser: spoken wording, times and numbers as people say them ("half past seven", "halb acht", "the twenty-third"), a filler word now and then, punctuation as a recogniser would put it',
  sentence: 'typed as a short, ordinary sentence or note',
  terse:
    'typed fast on a phone: lowercase, abbreviations, little or no punctuation ("haircut wed 4pm")',
  todo: 'to-dos and reminders to oneself ("remind me to …", "I need to …", "don\'t forget to …", "to-do: …", "ich muss …", "erinnere mich daran, … zu …", "nicht vergessen: …"), mixed with a few ordinary appointments',
} as const;

const FOCUSES = {
  allDay:
    'things without a time of day: birthdays, holidays, deadlines, trips, days off, "all day"',
  chatty:
    'chatty phrases with words that are not the event ("so I think I have", "can you put", "please", "ähm", "also")',
  clock:
    'clock times in every form: 12- and 24-hour, with and without am or pm, "half past", "quarter to", "noon", "midnight", "halb acht", "Viertel nach drei", "um 15 Uhr"',
  days: 'how the day is said: today, tomorrow, the day after tomorrow, a weekday, "next" and "this" weekday, a date with and without the month\'s name, "in three days", "in two weeks", the weekend, and no day at all',
  followUps:
    'the follow-ups. In this batch two thirds of the threads have them. They change the time, the day, the length, the title or the place ("it\'s the one in Porto", "at the gym instead", "no place after all"), add company ("with Maria"), invite someone or take someone off, add or drop a repeat, a note or a notification, or say "the whole day", "two hours later", "a bit earlier, at ten"',
  hard: 'phrases that are easy to misread: a person whose name is also a word or a place, a venue named like a day or a time, an event whose name holds a number, a title in another language than the sentence; and a few that give nothing to schedule at all (a greeting, a question, half a sentence)',
  long: 'long phrases that carry four or more details at once',
  meals:
    'meals and parts of the day said without a clock time: breakfast, brunch, lunch, dinner, "in the morning", "this afternoon", "tonight", "abends", "vormittags"',
  notes:
    'a note to keep with it ("note: bring the charger", "Notiz: …") and notifications ("remind me two hours before", "erinnere mich einen Tag vorher", "alert 15 minutes before")',
  people:
    'who it is with ("lunch with Maria") against whom to invite ("invite Ben", "add Ben as a guest", "lade Ben ein", an email address); some phrases have both',
  places:
    'where it is: a venue, a room, an address, a city, led in by "at", "in", "im", "bei", or simply said last',
  ranges:
    'a start and an end ("from 2 to 4", "von 14 bis 16 Uhr", "9–11") or a length ("for 90 minutes", "eine halbe Stunde lang")',
  repeats:
    'things that repeat: daily, on weekdays, weekly on one or several weekdays, every two weeks, monthly ("every second Tuesday", "last Friday of the month"), yearly, with an end ("until June", "ten times") and without',
  short: 'very short phrases: one to three words',
} as const;

/**
 * What a second round exercises: the two things the first round's model
 * could not do, and the first round's phrases hardly asked for. Their
 * briefs come after the first round's, so a brief keeps its number and a
 * thread its "today".
 */
const LATER_FOCUSES = {
  farDays:
    'days more than two weeks away: a date by its number, with and without the month ("on the 23rd", "March 14", "am 7.9.", "the third of May", "Thursday the 6th"), and an amount of time from today ("in three weeks", "in two months", "in einem halben Jahr", "heute in vier Wochen")',
  ruledOut:
    'things that repeat on all days or on all working days but one or two ("weekdays but not Wednesday", "each day except on weekends", "daily, just not Mondays", "täglich, nur sonntags nicht", "werktags außer mittwochs", "Montag bis Samstag ohne Donnerstag"); among the follow-ups, some that rule a day out of a repeat the draft has ("but not on Tuesdays", "nur dienstags nicht")',
} as const;

/**
 * What the third round (model v2) exercises: what v1 got wrong, mostly
 * follow-ups, and turning notifications off, which no phrase before
 * asked for. Their briefs come after the second round's, so no brief
 * changes its number and no thread its "today".
 */
const V2_FOCUSES = {
  alertEdits:
    'notifications. In this batch two thirds of the threads have one or two follow-ups: a notification added beside the one the draft has, one of two dropped, one moved to another time, all of them turned off. A third of the first phrases ask for no notification at all, in every English and German wording',
  guestEdits:
    'the guest list. In this batch every thread has one or two follow-ups to a draft that invites people: someone taken off the list again, someone swapped for someone else, one more invited. Some first phrases invite several people at once',
  kindSwitch:
    'the whole day against a time of day. In this batch every thread has one or two follow-ups: an event with a time made one that lasts the whole day, or one that lasts the whole day given a time, in every wording',
  renames:
    'new titles. In this batch every thread has one or two follow-ups, and most of them rename the draft: the new name replaces the old one entirely, said as a command or in passing ("Titel: Elternsprechtag", "let\'s call this the budget sync"); some rename and change something else at once',
  repeatEdits:
    'a repeat changed. In this batch every thread starts with something that repeats and has one or two follow-ups: the repeat ended so it happens just once, made more or less frequent, given an end date or a number of times, moved to other weekdays',
  shifts:
    'times moved or resized by an amount instead of a clock time. In this batch every thread has one or two follow-ups to a first phrase with a start time: the whole thing moved later or earlier by an amount, made longer or shorter by an amount while the start stays, or given a new length; amounts in every form (minutes, a quarter of an hour, an hour and a half, "zwanzig Minuten", "anderthalb Stunden"). Some first phrases give a start and a length',
} as const;

const FOCUS_TEXT: Readonly<Record<Brief['focus'], string>> = {
  ...FOCUSES,
  ...LATER_FOCUSES,
  ...V2_FOCUSES,
};

export interface Brief {
  readonly focus: keyof typeof FOCUSES | keyof typeof LATER_FOCUSES | keyof typeof V2_FOCUSES;
  readonly language: Language;
  readonly register: keyof typeof REGISTERS;
}

const sortedKeys = <Key extends string>(record: Readonly<Record<Key, unknown>>): Array<Key> =>
  (Object.keys(record) as Array<Key>).sort();

const briefsOf = (focuses: ReadonlyArray<Brief['focus']>): ReadonlyArray<Brief> =>
  (['en', 'de'] as const).flatMap((language) =>
    sortedKeys(REGISTERS).flatMap((register) =>
      focuses.map((focus) => ({ focus, language, register })),
    ),
  );

/** How many briefs the first round has: every language, way of writing and first focus once. */
export const FIRST_ROUND_BRIEFS = 2 * 5 * 14;

/** How many briefs the first two rounds have: model v1's data. */
export const V1_BRIEFS = FIRST_ROUND_BRIEFS + 2 * 5 * 2;

/** Every language, way of writing and focus once, each round's briefs after the one before. */
export const BRIEFS: ReadonlyArray<Brief> = [
  ...briefsOf(sortedKeys(FOCUSES)),
  ...briefsOf(sortedKeys(LATER_FOCUSES)),
  ...briefsOf(sortedKeys(V2_FOCUSES)),
];

/**
 * Find a time's sentences (model v2): one sentence each, the free time a
 * person looks for, never an event to add.
 */
const FINDER_REGISTERS = {
  command: 'said as a command to the finder ("find me …", "look for …", "such mir …", "finde …")',
  dictated: REGISTERS.dictated,
  question: 'asked as a question ("when am I free …?", "wann hätte ich …?", "is there … ?")',
  sentence: 'typed as a short, ordinary sentence or note about the time needed',
  terse: REGISTERS.terse,
} as const;

const FINDER_FOCUSES = {
  clockBounds:
    'clock times that bound the search: after a time, before a time, between two times, not before or no later than a time, in 12- and 24-hour forms',
  combined:
    'sentences that give four or more at once: a length, when to look, weekdays, a part of the day or clock bounds, what the time is for',
  dayParts:
    'parts of the day and meals instead of clock times: mornings, afternoons, evenings, over lunch, at breakfast, at dinner, "vormittags", "abends"',
  length:
    'how long the free time is: minutes and hours in every form, half and quarter hours, "anderthalb Stunden"; a few say no length at all',
  purpose:
    'what the time is for: a meeting, a call with someone, sport, an errand, focus work, a meal with someone, in the words of the sentence; and some that do not say',
  short: 'very short sentences: two to five words',
  weekdays:
    'which weekdays: one or two named days, working days, weekends, and days ruled out ("any day but Monday", "außer freitags")',
  window:
    'when to look: today, tomorrow, the day after tomorrow, this week, next week, the weekend, a weekday, the coming two weeks; a few say nothing about when',
} as const;

export interface FinderBrief {
  readonly focus: keyof typeof FINDER_FOCUSES;
  readonly language: Language;
  readonly register: keyof typeof FINDER_REGISTERS;
}

/** Every language, way of writing and finder focus once. */
export const FINDER_BRIEFS: ReadonlyArray<FinderBrief> = (['en', 'de'] as const).flatMap(
  (language) =>
    sortedKeys(FINDER_REGISTERS).flatMap((register) =>
      sortedKeys(FINDER_FOCUSES).map((focus) => ({ focus, language, register })),
    ),
);

/** A small seeded generator: the same brief draws the same names on every run. */
const seeded = (seed: number): (() => number) => {
  let state = (seed + 1) * 0x9e_37_79_b1;
  return () => {
    state = Math.imul(state ^ (state >>> 15), 0x2c_1b_3c_6d);
    state = Math.imul(state ^ (state >>> 12), 0x29_7a_2d_39);
    state ^= state >>> 15;
    return (state >>> 0) / 0x1_00_00_00_00;
  };
};

const drawn = <Item>(
  items: ReadonlyArray<Item>,
  count: number,
  random: () => number,
): Array<Item> => {
  const left = [...items];
  const picked: Array<Item> = [];
  while (picked.length < count && left.length > 0) {
    picked.push(...left.splice(Math.floor(random() * left.length), 1));
  }
  return picked;
};

export const GENERATOR_SCHEMA = {
  additionalProperties: false,
  properties: {
    threads: {
      items: {
        additionalProperties: false,
        properties: { turns: { items: { type: 'string' }, type: 'array' } },
        required: ['turns'],
        type: 'object',
      },
      type: 'array',
    },
  },
  required: ['threads'],
  type: 'object',
} as const;

/** What the generator is asked for one brief. It is shown no case of the bench. */
export const buildGeneratorPrompt = (
  brief: Brief,
  index: number,
  count: number,
  names: Names,
): string => {
  const random = seeded(index);
  const people = drawn(names.people, 8, random).map(([first, last]) => `${first} ${last}`);
  const places = drawn(names.places, 6, random);
  return [
    "You are writing practice phrases for a calendar app's quick-add box. A person types or",
    'dictates one short phrase and the app turns it into an event or a to-do. Afterwards they',
    'can say short follow-ups that change the draft ("move it to 3", "add Carla", "at the gym',
    'instead").',
    '',
    `Write ${String(count)} threads. A thread is the first phrase and, for about a third of the`,
    'threads, one or two follow-ups (never more than two).',
    '',
    `Language: ${brief.language === 'de' ? 'German, as people in Austria and Germany write and speak it' : 'English'}.`,
    `How the phrases are written: ${REGISTERS[brief.register]}.`,
    `What most of these threads should exercise: ${FOCUS_TEXT[brief.focus]}. The rest can be`,
    'anything a person might put in a calendar.',
    '',
    'Make them sound like real people, not like test data: different lengths, different lives',
    '(work, family, health, sport, travel, errands, school, hobbies), different ways of saying',
    'the same thing. No two threads may be about the same thing.',
    '',
    'When a phrase needs a person, use these (a first name alone, the full name, or an address',
    `of the form first.last@example.com, as a person would): ${people.join(', ')}. When it needs`,
    `a place, use these or make up others: ${places.join(', ')}.`,
    '',
    'Do not number the phrases and do not explain them.',
  ].join('\n');
};

export const FINDER_GENERATOR_SCHEMA = {
  additionalProperties: false,
  properties: { sentences: { items: { type: 'string' }, type: 'array' } },
  required: ['sentences'],
  type: 'object',
} as const;

/** What the generator is asked for one finder brief. It is shown no case of either bench. */
export const buildFinderGeneratorPrompt = (
  brief: FinderBrief,
  index: number,
  count: number,
  names: Names,
): string => {
  // Drawn apart from the threads' briefs, so the same index does not draw the same names.
  const random = seeded(10_000 + index);
  const people = drawn(names.people, 8, random).map(([first, last]) => `${first} ${last}`);
  const places = drawn(names.places, 4, random);
  return [
    'You are writing practice sentences for a calendar app\'s "find a time" box. A person types',
    'or dictates one sentence saying what free time they need, and the app searches their',
    'calendar for slots that fit. It is never an event to add: it is time to look for.',
    '',
    `Write ${String(count)} sentences.`,
    '',
    `Language: ${brief.language === 'de' ? 'German, as people in Austria and Germany write and speak it' : 'English'}.`,
    `How the sentences are written: ${FINDER_REGISTERS[brief.register]}.`,
    `What most of them should exercise: ${FINDER_FOCUSES[brief.focus]}. The rest can be any`,
    'free time a person might look for.',
    '',
    'Make them sound like real people, not like test data: different lengths, different lives',
    '(work, family, health, sport, errands, school, hobbies), different ways of saying the same',
    'thing. No two sentences may be about the same thing.',
    '',
    `When a sentence needs a person, use these (a first name alone or the full name): ${people.join(', ')}.`,
    `When it needs a place, use these or make up others: ${places.join(', ')}.`,
    '',
    'Do not number the sentences and do not explain them.',
  ].join('\n');
};

/** The sentences in a generator's answer, none empty. */
export const sentencesOf = (answer: unknown): ReadonlyArray<string> => {
  const sentences =
    typeof answer === 'object' && answer !== null && 'sentences' in answer ? answer.sentences : [];
  return Array.isArray(sentences)
    ? sentences
        .filter((sentence): sentence is string => typeof sentence === 'string')
        .map((sentence) => sentence.trim().replaceAll(/\s+/gu, ' '))
        .filter(Boolean)
    : [];
};

/**
 * The example phrases the briefs quote: a phrase that repeats one word
 * for word is the brief's text, not the generator's, and is left out.
 * Only examples of two words or more without an ellipsis count.
 */
export const BRIEF_EXAMPLES: ReadonlyArray<string> = [
  ...Object.values(REGISTERS),
  ...Object.values(FOCUS_TEXT),
  ...Object.values(FINDER_REGISTERS),
  ...Object.values(FINDER_FOCUSES),
].flatMap((text) =>
  [...text.matchAll(/"([^"]+)"/gu)].flatMap(([, quoted]) => {
    const example = fold(quoted ?? '');
    return example.includes('…') || example.split(' ').length < 2 ? [] : [example];
  }),
);

/** Whether a phrase holds one of the briefs' examples word for word. */
export const repeatsBriefExample = (text: string): boolean => {
  const folded = ` ${fold(text)} `;
  return BRIEF_EXAMPLES.some((example) => folded.includes(` ${example} `));
};

/** The threads in a generator's answer: one to three phrases each, none empty. */
export const threadsOf = (answer: unknown): ReadonlyArray<ReadonlyArray<string>> => {
  const threads =
    typeof answer === 'object' && answer !== null && 'threads' in answer ? answer.threads : [];
  if (!Array.isArray(threads)) {
    return [];
  }
  return threads.flatMap((thread: unknown) => {
    const turns =
      typeof thread === 'object' && thread !== null && 'turns' in thread ? thread.turns : [];
    if (!Array.isArray(turns)) {
      return [];
    }
    const said = turns
      .filter((turn): turn is string => typeof turn === 'string')
      .map((turn) => turn.trim().replaceAll(/\s+/gu, ' '))
      .filter(Boolean)
      .slice(0, 3);
    return said.length === 0 ? [] : [said];
  });
};

const wordsOf = (text: string): ReadonlySet<string> =>
  new Set(
    fold(text)
      .split(/[^\p{L}\p{N}@.]+/u)
      .filter(Boolean),
  );

/** From this many words on, a bench phrase said whole inside a longer one gives it away. */
const WHOLE_FROM_WORDS = 3;

/**
 * Whether a phrase reads like one of the bench's: four fifths of the
 * words shared, or a bench phrase of three words or more said whole
 * inside it ("actually make it 8"). Such a phrase is left out of the
 * training data, so a trained model has not seen the test.
 */
export const nearBench = (text: string, benchPhrases: ReadonlyArray<string>): boolean => {
  const words = wordsOf(text);
  if (words.size === 0) {
    return true;
  }
  return benchPhrases.some((phrase) => {
    const other = wordsOf(phrase);
    const shared = [...other].filter((word) => words.has(word)).length;
    const union = new Set([...words, ...other]).size;
    return (
      (union > 0 && shared / union >= 0.8) ||
      (other.size >= WHOLE_FROM_WORDS && shared === other.size)
    );
  });
};

const FIRST_DAY = Temporal.PlainDate.from('2026-01-01');
const DAYS_COVERED = 730;

/** The "today" of a thread: spread over two years, so no weekday or month is learned by heart. */
export const referenceDateOf = (index: number): string =>
  FIRST_DAY.add({ days: (index * 37 + 11) % DAYS_COVERED }).toString();
