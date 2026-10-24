import {
  type ByDay,
  foldSearchText,
  type RecurrenceFrequency,
  Temporal,
  validateEventDraft,
} from '@calendar/core';
import { groundDate, groundTime, groundTitle, isTodoPhrase, trimWhen } from './grounding.ts';
import { inviteesOf, titleWithoutInvitees } from './invitees.ts';
import type { QuickAddParse } from './quickAdd.ts';
import { meaningfulText, realDate, realTime } from './shared.ts';

/** Editor prefill: exactly the fields the shared editor model seeds from. */
export interface QuickAddPrefill {
  /**
   * The times came from a meal or part of the day the phrase named, not a
   * clock time it stated: the editor marks them so, until they are set.
   */
  readonly assumedTime?: boolean | undefined;
  readonly date: string;
  /**
   * The day it ends on, when not `date`: only the editor's form sets one
   * (a multi-day or overnight draft); a refinement keeps the span.
   */
  readonly endDate?: string | undefined;
  readonly endTime: string;
  readonly isAllDay: boolean;
  readonly location?: string | undefined;
  /**
   * Recurrence as the editor's own fields, not a built RRULE — the editor
   * shows them and builds the rule itself on save.
   */
  readonly recurrence?:
    | {
        /** Weekdays the editor chose; a parsed phrase never sets them, a refinement keeps them. */
        readonly byDay?: ReadonlyArray<ByDay> | undefined;
        readonly count?: number | undefined;
        readonly freq: RecurrenceFrequency;
        readonly interval?: number | undefined;
        readonly untilDate?: string | undefined;
      }
    | undefined;
  readonly startTime: string;
  readonly title: string;
}

/** A phrase understood as a to-do: what the task editor opens with. */
export interface QuickAddTaskPrefill {
  readonly date: string;
  /** `HH:MM` when the phrase named a time (only a Reminders list keeps it). */
  readonly time?: string;
  readonly title: string;
}

export type QuickAddResult =
  | {
      /** Names or addresses the words invite, as said: the thread looks them up in the contacts. */
      readonly invite?: ReadonlyArray<string> | undefined;
      readonly kind: 'parsed';
      readonly prefill: QuickAddPrefill;
      /** Names or addresses the words take off the guest list (a refinement only). */
      readonly uninvite?: ReadonlyArray<string> | undefined;
    }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'task'; readonly prefill: QuickAddTaskPrefill };

const FREQUENCIES = new Set<RecurrenceFrequency>(['daily', 'monthly', 'weekly', 'yearly']);

/**
 * A repeat end before the first day reads as next year's: "every Monday
 * until March", said in October, means the coming March, and models
 * answer with this year's. Still before the start a year on, it is a
 * misread and dropped — the editor would refuse it.
 */
const untilOnOrAfter = (until: string | undefined, start: string): string | undefined => {
  if (until === undefined || until >= start) {
    return until;
  }
  const nextYear = Temporal.PlainDate.from(until).add({ years: 1 }).toString();
  return nextYear >= start ? nextYear : undefined;
};

/** One hour on, clamped to the day: the editor works on one date. */
export const addHour = (time: string): string => {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  return hour >= 23
    ? '23:59'
    : `${String(hour + 1).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

/**
 * The cue that made the phrase a to-do, when the model left it in the
 * title ("remind me to call the bank" came back whole): the title is the
 * thing to do.
 */
const TODO_CUE_PREFIX =
  /^(?:remind me to|reminder:?|to-?do:?|don'?t forget to|i (?:need|have) to|i must|ich muss|nicht vergessen:?)\s+/i;

/**
 * The first letter upper-cased when the first word is all lower case
 * ("lunch with tom" is "Lunch with tom"); "iPhone repair" stays as typed.
 */
const capitalized = (title: string): string =>
  /\p{Lu}/u.test(/^\S*/u.exec(title)![0])
    ? title
    : title.replace(/^\p{Ll}/u, (letter) => letter.toLocaleUpperCase());

/** Lower-case, accent-free text with straight apostrophes and "ss" for ß. */
const fold = (text: string): string =>
  foldSearchText(text)
    .replaceAll(/[‘’`]/g, "'")
    .replaceAll('ß', 'ss');

/**
 * The words that put a place after them ("at Figlmüller", "in Vienna",
 * "bei Anna", "im Café Central"), an article allowed between.
 */
const PLACE_CUE =
  /(?:^|[^\p{L}])(?:at|in|@|bei|beim|im|am|ins|zum|zur|in der|in dem|an der|auf der|auf dem|vor dem|vor der|chez)\s+(?:(?:the|a|an|der|die|das|dem|den|ein|eine|einem|einer)\s+)?$/u;

/**
 * The place the model extracted, held against the phrase: it must be in
 * the words (the real model made up "Bob's house" and "unknown"), and
 * where it is also part of the title ("Dentist" for "Dentist tomorrow
 * at 9", "Board review" for "Board review Thursday 2pm") it counts only
 * after a place cue in the phrase ("Meeting at the office"). The title
 * over again is never a place. Without a phrase (capture) the model's
 * place stands as it is, as it always did — a reservation titled and
 * placed "Figlmüller" keeps its place.
 */
export const placeOf = (
  location: string | undefined,
  title: string,
  phrase?: string,
): string | undefined => {
  // Capture (no phrase) keeps the model's place as it is, as it always did.
  if (location === undefined || phrase === undefined) {
    return location;
  }
  if (fold(location) === fold(title)) {
    return undefined;
  }
  const words = fold(phrase);
  const place = fold(location);
  const at = words.indexOf(place);
  if (at === -1) {
    return undefined;
  }
  if (!fold(title).includes(place)) {
    return location;
  }
  // Any occurrence after a cue will do ("at 1 at Figlmüller" has two "at"s).
  for (let from = at; from !== -1; from = words.indexOf(place, from + 1)) {
    if (PLACE_CUE.test(words.slice(0, from))) {
      return location;
    }
  }
  return undefined;
};

/**
 * The repeat the model returned, as the editor's fields, or none.
 * "Repeats once" is not a repeat (models attach one to phrases like
 * "next Tuesday"), an unknown frequency is dropped, and an end before
 * the first day reads as next year's.
 */
export const recurrenceFromParse = (
  parsed: QuickAddParse['recurrence'],
  firstDay: string,
): QuickAddPrefill['recurrence'] => {
  const count = parsed?.count;
  const parsedFreq = parsed?.freq;
  const freq = count === 1 || !parsedFreq || !FREQUENCIES.has(parsedFreq) ? undefined : parsedFreq;
  if (!freq) {
    return undefined;
  }
  const untilDate = untilOnOrAfter(realDate(parsed?.untilDate), firstDay);
  return {
    ...(typeof count === 'number' && count > 1 ? { count } : {}),
    freq,
    ...(typeof parsed?.interval === 'number' ? { interval: parsed.interval } : {}),
    ...(untilDate ? { untilDate } : {}),
  };
};

/**
 * Turns raw model output into a prefill the editor can open, or rejects it.
 *
 * The model is trusted only for extraction; every value is re-checked here,
 * because a schema-shaped answer can still be nonsense (23:70, a title of
 * whitespace, an end before its start). Given the phrase, the answer is
 * also held against it (`grounding.ts`): the start must be a clock time
 * the phrase states or the default of a meal or part of the day it names,
 * else the event is all day; the end comes only from a stated range; a
 * weekday the phrase names is where the date lands; the phrase is a
 * to-do only on a to-do cue; only the people it says to invite are
 * invited (`invitees.ts`), the invitation kept out of the title; and the
 * title is the phrase's own words, without the when at its ends. Capture
 * has no one phrase per item, so it passes none and the model's times
 * stand as validated.
 */
export const normalizeQuickAdd = (
  parse: QuickAddParse,
  {
    fallbackDate,
    people,
    phrase,
    referenceDate,
    timeZone,
  }: {
    /**
     * Used when the phrase named no date — the day the user is looking at,
     * which is not necessarily today. `referenceDate` stays the anchor for
     * relative phrases like "tomorrow".
     */
    fallbackDate?: string | undefined;
    /** The names the model read as invited (`readPeople`), held against the phrase. */
    people?: ReadonlyArray<string> | undefined;
    /** The words the answer came from; when given, the answer is checked against them. */
    phrase?: string | undefined;
    referenceDate: string;
    timeZone: string;
  },
): QuickAddResult => {
  const todo = phrase !== undefined && isTodoPhrase(phrase);
  // Who the words invite, held against them. A to-do invites no one ("remind
  // me to invite Tom" is the thing to do); capture reads no one.
  const { invite } = phrase === undefined || todo ? { invite: [] } : inviteesOf(people, phrase);
  const said = meaningfulText(parse.title);
  // Only the phrase's words, without the invitation and the when at its
  // ends (`grounding.ts`). Capture has no phrase: the model's title stands.
  const named =
    said === undefined
      ? undefined
      : titleWithoutInvitees(phrase === undefined ? said : groundTitle(said, phrase), invite);
  const title = named && phrase !== undefined ? capitalized(trimWhen(named)) : named;
  if (!title) {
    return { kind: 'rejected', reason: 'No event title was recognised.' };
  }

  const modelDate = realDate(parse.date?.trim());
  const groundedDate =
    phrase === undefined ? undefined : groundDate(modelDate, { phrase, referenceDate });
  const resolvedDate = groundedDate ?? modelDate ?? realDate(fallbackDate) ?? referenceDate;
  if (!realDate(resolvedDate)) {
    return { kind: 'rejected', reason: 'That date could not be understood.' };
  }

  const modelStart = realTime(parse.startTime);
  const times =
    phrase === undefined
      ? { endTime: realTime(parse.endTime), source: 'model' as const, startTime: modelStart }
      : groundTime(modelStart, phrase);
  const { startTime } = times;
  if (todo) {
    // A to-do: its day, and its time when one was said. No end, no repeat.
    return {
      kind: 'task',
      prefill: {
        date: resolvedDate,
        ...(startTime ? { time: startTime } : {}),
        title: capitalized(title.replace(TODO_CUE_PREFIX, '') || title),
      },
    };
  }
  // No usable time at all means the phrase described a whole day. Without
  // a phrase the model may also say so outright.
  const isAllDay = !startTime || (phrase === undefined && parse.isAllDay === true);
  const resolvedStart = isAllDay ? '00:00' : startTime!;
  // A missing or backwards end becomes a one-hour event rather than an error:
  // "lunch at 1" is a complete thought.
  const resolvedEnd =
    !isAllDay && times.endTime && times.endTime > resolvedStart
      ? times.endTime
      : addHour(resolvedStart);
  if (!isAllDay && resolvedEnd <= resolvedStart) {
    // Only reachable in the final minute of the day: the editor puts start
    // and end on one date, so nothing after 23:59 can be expressed.
    return {
      kind: 'rejected',
      reason: 'That would end after midnight — pick an earlier time.',
    };
  }

  const fields = {
    calendarKey: 'placeholder:placeholder',
    date: resolvedDate,
    endTime: resolvedEnd,
    isAllDay,
    startTime: resolvedStart,
    title,
  };
  const invalid = validateEventDraft(fields, timeZone);
  if (invalid) {
    return { kind: 'rejected', reason: invalid };
  }

  // Capture passes no phrase and keeps its locations as before.
  const location = placeOf(meaningfulText(parse.location), title, phrase);
  const recurrence = recurrenceFromParse(parse.recurrence, resolvedDate);

  return {
    ...(invite.length > 0 ? { invite } : {}),
    kind: 'parsed',
    prefill: {
      ...(times.source === 'period' ? { assumedTime: true } : {}),
      date: resolvedDate,
      endTime: resolvedEnd,
      isAllDay,
      ...(location ? { location } : {}),
      ...(recurrence ? { recurrence } : {}),
      startTime: resolvedStart,
      title,
    },
  };
};
