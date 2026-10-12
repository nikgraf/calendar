import { type ByDay, type RecurrenceFrequency, Temporal, validateEventDraft } from '@calendar/core';
import { groundDate, groundTime, isTodoPhrase } from './grounding.ts';
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
  | { readonly kind: 'parsed'; readonly prefill: QuickAddPrefill }
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
 * A location that is the title over again ("Dentist" for "Dentist
 * Thursday") is the title copied over, not a place. Only the whole title
 * counts: "New York" is the place of "New York trip".
 */
export const placeOf = (location: string | undefined, title: string): string | undefined =>
  location !== undefined && location.toLowerCase() === title.toLowerCase() ? undefined : location;

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
 * weekday the phrase names is where the date lands; and the phrase is a
 * to-do only on a to-do cue. Capture has no one phrase per item, so it
 * passes none and the model's times stand as validated.
 */
export const normalizeQuickAdd = (
  parse: QuickAddParse,
  {
    fallbackDate,
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
    /** The words the answer came from; when given, the answer is checked against them. */
    phrase?: string | undefined;
    referenceDate: string;
    timeZone: string;
  },
): QuickAddResult => {
  const title = meaningfulText(parse.title);
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
  if (phrase !== undefined && isTodoPhrase(phrase)) {
    // A to-do: its day, and its time when one was said. No end, no repeat.
    return {
      kind: 'task',
      prefill: {
        date: resolvedDate,
        ...(startTime ? { time: startTime } : {}),
        title: title.replace(TODO_CUE_PREFIX, '') || title,
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

  const place = meaningfulText(parse.location);
  // Capture passes no phrase and keeps its locations as before.
  const location = phrase === undefined ? place : placeOf(place, title);
  const recurrence = recurrenceFromParse(parse.recurrence, resolvedDate);

  return {
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
