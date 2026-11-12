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

/** People for the phrases and the address book they are looked up in. None is in the bench's book. */
const PEOPLE: ReadonlyArray<readonly [string, string]> = [
  ['Carla', 'Reyes'],
  ['Ben', 'Okafor'],
  ['Mira', 'Solberg'],
  ['Jonas', 'Keller'],
  ['Priya', 'Nair'],
  ['Lukas', 'Brandt'],
  ['Elena', 'Costa'],
  ['Felix', 'Aigner'],
  ['Nora', 'Lindqvist'],
  ['Omar', 'Haddad'],
  ['Hannah', 'Vogel'],
  ['Dmitri', 'Volkov'],
  ['Sophie', 'Lang'],
  ['Kenji', 'Mori'],
  ['Laura', 'Pichler'],
  ['Samir', 'Rahman'],
  ['Greta', 'Hofer'],
  ['Pablo', 'Ortega'],
  ['Ines', 'Wagner'],
  ['Callum', 'Reid'],
  ['Zofia', 'Kowalska'],
  ['Moritz', 'Steiner'],
  ['Aylin', 'Demir'],
  ['Viktor', 'Horvat'],
  ['Lena', 'Schuster'],
  ['Rafael', 'Mendes'],
  ['Katrin', 'Bauer'],
  ['Niklas', 'Frey'],
  ['Amara', 'Diallo'],
  ['Paul', 'Gruber'],
  ['Yuki', 'Tanaka'],
  ['Marlene', 'Koch'],
  ['Tobias', 'Winkler'],
  ['Leila', 'Farouk'],
  ['Simon', 'Egger'],
  ['Clara', 'Jensen'],
  ['Emil', 'Hartmann'],
  ['Renate', 'Schwarz'],
  ['Hugo', 'Lefevre'],
  ['Maja', 'Petrovic'],
];

const PLACES: ReadonlyArray<string> = [
  'Café Lindner',
  'the Riverside Gym',
  'Studio 4',
  'Gasthaus zum Hirschen',
  'the Maple Room',
  'Hauptbahnhof',
  'Kino am Markt',
  'Dr. Albrecht’s office',
  'the Harbour Kitchen',
  'Stadtbibliothek',
  'room 2.14',
  'Trattoria Nonna',
  'the climbing hall',
  'Volksgarten',
  'the north office',
  'Praxis Dr. Sommer',
  'Pier 7',
  'the school gym',
  'Besprechungsraum Donau',
  'Yoga Loft',
  'Flughafen Wien',
  'the old town hall',
  'Weinbar Rebe',
  '12 Mill Lane',
  'Lindengasse 8',
  'the community pool',
  'Porto',
  'Innsbruck',
  'Leipzig',
  'Bar Tabac',
];

export const trainingBook: ReadonlyArray<Contact> = PEOPLE.map(
  ([first, last], index) =>
    new Contact({
      displayName: `${first} ${last}`,
      email: `${first}.${last}@example.com`.toLowerCase(),
      id: `device:${String(index)}:${first}.${last}`.toLowerCase(),
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

export interface Brief {
  readonly focus: keyof typeof FOCUSES;
  readonly language: Language;
  readonly register: keyof typeof REGISTERS;
}

const sortedKeys = <Key extends string>(record: Readonly<Record<Key, unknown>>): Array<Key> =>
  (Object.keys(record) as Array<Key>).sort();

/** Every language, way of writing and focus once: what one round of generating covers. */
export const BRIEFS: ReadonlyArray<Brief> = (['en', 'de'] as const).flatMap((language) =>
  sortedKeys(REGISTERS).flatMap((register) =>
    sortedKeys(FOCUSES).map((focus) => ({ focus, language, register })),
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
export const buildGeneratorPrompt = (brief: Brief, index: number, count: number): string => {
  const random = seeded(index);
  const people = drawn(PEOPLE, 8, random).map(([first, last]) => `${first} ${last}`);
  const places = drawn(PLACES, 6, random);
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
    `What most of these threads should exercise: ${FOCUSES[brief.focus]}. The rest can be`,
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
