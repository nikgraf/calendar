import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Contact } from '@calendar/core';
import { Schema } from 'effect';

/**
 * A bench case: one file under `cases/`, a list of turns. The first turn
 * is a phrase, every later one a change to the draft it left, as the
 * Assistant's thread does. A turn's input is text, or a
 * recording with the transcript of what was said; the recording goes
 * through the helper's SpeechAnalyzer and the transcript tells the
 * recogniser's errors from the parser's. Expectations say where a person
 * would put the event — never a literal date, since the bench runs on
 * "today": a weekday, an offset from today, a day of the month, a time,
 * folded text.
 */

const Guests = Schema.Struct({
  /** Names still to pick from after the turn, as said. Absent: none. */
  choices: Schema.optional(Schema.Array(Schema.String)),
  /** The guest list after the turn, by address. Absent: nobody. */
  emails: Schema.optional(Schema.Array(Schema.String)),
});

const Repeat = Schema.Struct({
  /**
   * The weekdays a weekly rule falls on, in any order ("every weekday":
   * MO–FR), or a monthly rule's weekday with its place in the month in
   * front: `1TU` the first Tuesday, `-1FR` the last Friday. The place is
   * part of what is checked: the first Friday is not the last one.
   */
  byDay: Schema.optional(Schema.Array(Schema.String)),
  count: Schema.optional(Schema.Number),
  freq: Schema.Literals(['daily', 'monthly', 'weekly', 'yearly']),
  /** Absent reads as 1. */
  interval: Schema.optional(Schema.Number),
  /** The month (1–12) the repeat ends in: never a literal date. */
  untilMonth: Schema.optional(Schema.Number),
});

export const Expectation = Schema.Struct({
  /** The times came from a meal or part of the day, not a stated clock time. */
  assumedTime: Schema.optional(Schema.Boolean),
  /**
   * The day of the month (1–31) a date said by its number lands on ("the
   * 23rd", "Oct 20"): never a year. The date is then also held to the
   * next such day from today on; a later turn may keep the month of the
   * draft it changes instead.
   */
  dayOfMonth: Schema.optional(Schema.Number),
  /** Days from today the draft lands on (0 today, 1 tomorrow). */
  dayOffset: Schema.optional(Schema.Number),
  /** `HH:MM`; a task has no end. */
  endTime: Schema.optional(Schema.String),
  guests: Schema.optional(Guests),
  isAllDay: Schema.optional(Schema.Boolean),
  kind: Schema.optional(Schema.Literals(['event', 'task'])),
  /** Folded text the location must contain; `null` for no location at all. */
  location: Schema.optional(Schema.NullOr(Schema.String)),
  /** The whole location, compared folded: for a turn that must not keep what was there. */
  locationIs: Schema.optional(Schema.String),
  /** The month (1–12) a date said with its month lands in: the next such month, like `dayOfMonth`. */
  month: Schema.optional(Schema.Number),
  /** Folded text the notes must contain. */
  notes: Schema.optional(Schema.String),
  /**
   * MapKit's names for the place meant, beside the text that names it
   * (`location` or `locationIs`): where the run asks MapKit, the location
   * is right when the app's lookup takes or offers a place whose name
   * begins with one of them, whatever the text reads; where it does not
   * (no helper, `MODEL_BENCH_PLACES=off`), or finds none, the text decides.
   */
  place: Schema.optional(Schema.Array(Schema.String)),
  /** The turn must be refused (an empty phrase, an end before its start). */
  rejected: Schema.optional(Schema.Boolean),
  /** Notifications as minutes before the start, in any order. */
  reminders: Schema.optional(Schema.Array(Schema.Number)),
  /** `null` for no repeat at all. */
  repeat: Schema.optional(Schema.NullOr(Repeat)),
  /** Days from the day it starts to the day it ends: 1 for an event that ends after midnight, 0 for one day. */
  spanDays: Schema.optional(Schema.Number),
  /** `HH:MM`; a task's own time. */
  startTime: Schema.optional(Schema.String),
  /** The whole title, compared folded (case, accents, ß); several are the titles a person would accept. */
  title: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  /** Folded text the title must contain. */
  titleIncludes: Schema.optional(Schema.String),
  /** ISO weekday (1 Monday … 7 Sunday) the draft lands on. */
  weekday: Schema.optional(Schema.Number),
});

export type Expectation = typeof Expectation.Type;
export type RepeatExpectation = typeof Repeat.Type;

const TextInput = Schema.Struct({ text: Schema.String });
const AudioInput = Schema.Struct({
  /** A file under `audio/`. Missing, the transcript is parsed instead. */
  audio: Schema.String,
  /** What was said, word for word. */
  transcript: Schema.String,
});

export type TurnInput = typeof TextInput.Type | typeof AudioInput.Type;

const Turn = Schema.Struct({
  expect: Expectation,
  input: Schema.Union([TextInput, AudioInput]),
});

export type BenchTurn = typeof Turn.Type;

const CaseFile = Schema.Struct({
  /**
   * A blind case: every score counts it and no table names it, so its
   * misses are not read while briefs or prompts are written and it stays
   * a test nobody tuned to. The README says how the set is kept.
   */
  blind: Schema.optional(Schema.Boolean),
  /** The address book (a key in contacts.json) names are looked up in. */
  contacts: Schema.optional(Schema.String),
  lang: Schema.Literals(['de', 'en']),
  /** The recogniser's locale; the language picks a default. */
  locale: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  turns: Schema.Array(Turn),
});

export interface BenchCase extends Omit<typeof CaseFile.Type, 'blind' | 'contacts' | 'tags'> {
  readonly blind: boolean;
  readonly contacts: string;
  /** The file's name. */
  readonly id: string;
  readonly tags: ReadonlyArray<string>;
}

export const DEFAULT_BOOK = 'team';

const decodeCase = Schema.decodeUnknownSync(CaseFile);

/** A weekday code as an expectation writes it: `MO`, or with its place in the month, `1MO`, `-1FR`. */
const BY_DAY = /^(?:-1|[1-5])?(?:MO|TU|WE|TH|FR|SA|SU)$/u;

/** A place meant comes with the text that names it: the text decides where MapKit is not asked. */
const checkPlace = (parsed: typeof CaseFile.Type): void => {
  for (const turn of parsed.turns) {
    const { location, locationIs, place } = turn.expect;
    if (place === undefined) {
      continue;
    }
    if (place.length === 0 || place.some((name) => name.trim() === '')) {
      throw new Error("place lists MapKit's names for the place meant");
    }
    if (typeof location !== 'string' && locationIs === undefined) {
      throw new Error(
        'place needs location or locationIs beside it: the text that names the place',
      );
    }
  }
};

/** A case's repeat days are weekday codes: a typo there would be a case no answer can pass. */
const checkByDay = (parsed: typeof CaseFile.Type): void => {
  for (const turn of parsed.turns) {
    for (const code of turn.expect.repeat?.byDay ?? []) {
      if (!BY_DAY.test(code)) {
        throw new Error(`repeat.byDay "${code}" is no weekday code (MO, 1TU, -1FR)`);
      }
    }
  }
};

/** Every `cases/*.json`, by file name. A file that does not parse names itself. */
export const loadCases = (dir: string): ReadonlyArray<BenchCase> =>
  readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      let parsed: typeof CaseFile.Type;
      try {
        parsed = decodeCase(JSON.parse(readFileSync(join(dir, file), 'utf8')));
        checkByDay(parsed);
        checkPlace(parsed);
      } catch (error) {
        throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
      // The first turn makes an event unless the case says a to-do; a later
      // turn keeps the kind, which the unchanged rule holds it to.
      const [first, ...rest] = parsed.turns;
      const turns =
        first === undefined
          ? parsed.turns
          : [{ ...first, expect: { kind: 'event' as const, ...first.expect } }, ...rest];
      return {
        ...parsed,
        blind: parsed.blind ?? false,
        contacts: parsed.contacts ?? DEFAULT_BOOK,
        id: basename(file, '.json'),
        tags: parsed.tags ?? [],
        turns,
      };
    });

/**
 * The cases a comma-separated selection names: each term is part of an
 * id or a whole tag ("flow,de"). No selection, every case. A selection
 * names open cases only, unless the blind ones are shown: a run of a few
 * cases would give a blind one's outcome away by its counts.
 */
export const filterCases = (
  cases: ReadonlyArray<BenchCase>,
  selection: string | undefined,
  { showBlind = false }: { readonly showBlind?: boolean | undefined } = {},
): ReadonlyArray<BenchCase> => {
  const terms = (selection ?? '')
    .split(',')
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  if (terms.length === 0) {
    return cases;
  }
  return cases.filter(
    (benchCase) =>
      (showBlind || !benchCase.blind) &&
      terms.some(
        (term) =>
          benchCase.id.toLowerCase().includes(term) ||
          benchCase.tags.some((tag) => tag.toLowerCase() === term),
      ),
  );
};

/** The recogniser's locale for a case: its own, else its language's default. */
export const localeOf = (benchCase: BenchCase): string =>
  benchCase.locale ?? (benchCase.lang === 'de' ? 'de-DE' : 'en-US');

const ContactsFile = Schema.Record(
  Schema.String,
  Schema.Array(
    Schema.Struct({
      displayName: Schema.optional(Schema.String),
      email: Schema.String,
    }),
  ),
);

/** The fixture address books, as the contacts the app would hold (device contacts). */
export const loadContacts = (path: string): Readonly<Record<string, ReadonlyArray<Contact>>> => {
  const books = Schema.decodeUnknownSync(ContactsFile)(JSON.parse(readFileSync(path, 'utf8')));
  return Object.fromEntries(
    Object.entries(books).map(([name, people]) => [
      name,
      people.map(
        (person, index) =>
          new Contact({
            ...(person.displayName === undefined ? {} : { displayName: person.displayName }),
            email: person.email,
            id: `device:${String(index)}:${person.email}`,
            source: 'device',
          }),
      ),
    ]),
  );
};
