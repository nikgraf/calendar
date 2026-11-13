import {
  addDaysToPlainDate,
  type ByDay,
  daysBetweenPlainDates,
  type RecurrenceFrequency,
  Temporal,
  validateEventDraft,
  type Weekday,
  WEEKDAYS_MONDAY_FIRST,
} from '@calendar/core';
import type { NotesChange, ReminderChange } from './extras.ts';
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
        /**
         * The days the phrase or the editor chose: a weekly rule's set
         * ("every weekday", "Mondays and Wednesdays"), a monthly rule's
         * "Nth weekday". A single weekday is the date's, never listed; a
         * refinement keeps the editor's days.
         */
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
      /** What the words do to the draft's notes (`extras.ts`); a first phrase's note is the draft's. */
      readonly notes?: NotesChange | undefined;
      readonly prefill: QuickAddPrefill;
      /** What the words do to the draft's notifications (`extras.ts`). */
      readonly reminders?: ReminderChange | undefined;
      /**
       * A refinement only: the words state the day ("today", "tomorrow",
       * a weekday), even where it is the day the draft held. A to-do kept
       * without a due day has a placeholder there, and "today" said of it
       * must date it.
       */
      readonly saidDay?: true | undefined;
      /** Names or addresses the words take off the guest list (a refinement only). */
      readonly uninvite?: ReadonlyArray<string> | undefined;
    }
  | { readonly kind: 'rejected'; readonly reason: string }
  | {
      readonly kind: 'task';
      /** A to-do's notes, when the words add one; it takes no notifications. */
      readonly notes?: NotesChange | undefined;
      readonly prefill: QuickAddTaskPrefill;
    };

/** A turn's result: a change never makes the draft a to-do. */
export type RefineResult = Exclude<QuickAddResult, { readonly kind: 'task' }>;

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

const positiveInt = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isInteger(value) && value >= 1 ? value : undefined;

const modelFreq = (parsed: QuickAddParse['recurrence']): RecurrenceFrequency | undefined =>
  parsed?.freq !== undefined && FREQUENCIES.has(parsed.freq) ? parsed.freq : undefined;

/** The first day on or after `date` that is a `weekday`. */
const nextOn = (date: string, weekday: Weekday): string => {
  const from = Temporal.PlainDate.from(date);
  const target = WEEKDAYS_MONDAY_FIRST.indexOf(weekday) + 1;
  return from.add({ days: (target - from.dayOfWeek + 7) % 7 }).toString();
};

/**
 * Whether a date is the Nth such weekday of its month as BYDAY counts
 * (the 4th may also be the last; `monthlyOrdinalOf` labels it "last"
 * for the picker, the rule means either).
 */
const isNthWeekday = (date: string, ordinal: number): boolean => {
  const day = Temporal.PlainDate.from(date);
  return ordinal === -1 ? day.day > day.daysInMonth - 7 : Math.ceil(day.day / 7) === ordinal;
};

/** The number of the week (Monday first) a day falls in, counted from a fixed Monday. */
const weekOf = (day: string): number =>
  Math.floor(
    daysBetweenPlainDates(
      '2024-01-01',
      addDaysToPlainDate(day, 1 - Temporal.PlainDate.from(day).dayOfWeek),
    ) / 7,
  );

/**
 * The first day a rule with chosen weekdays falls on, on or after `date`:
 * a weekly rule's next listed day, a monthly rule's next "Nth weekday".
 * A start the rule skips is drawn as one more first occurrence
 * (`expand.ts`), which "every weekday" said on a Saturday never means.
 */
export const firstDayOn = (
  date: string,
  recurrence: QuickAddPrefill['recurrence'],
  { keepPhase = false }: { readonly keepPhase?: boolean } = {},
): string => {
  const days = recurrence?.byDay ?? [];
  const [first] = days;
  if (recurrence === undefined || first === undefined) {
    return date;
  }
  if (recurrence.freq === 'weekly') {
    const interval = recurrence.interval ?? 1;
    return days
      .map((day) => {
        const next = nextOn(date, day.weekday);
        // A draft's start anchors its cycle: a start moved off its day stays
        // in a week the rule falls in ("every other week" keeps its weeks).
        const weeksOn = (weekOf(next) - weekOf(date)) % interval;
        return keepPhase && interval > 1 && weeksOn !== 0
          ? addDaysToPlainDate(next, 7 * (interval - weeksOn))
          : next;
      })
      .sort()[0]!;
  }
  if (recurrence.freq === 'monthly' && first.ordinal !== undefined) {
    // Every month has a 1st to 4th and a last of each weekday: six weeks on at most.
    let candidate = nextOn(date, first.weekday);
    for (let week = 0; week < 6; week += 1) {
      if (isNthWeekday(candidate, first.ordinal)) {
        return candidate;
      }
      candidate = addDaysToPlainDate(candidate, 7);
    }
  }
  return date;
};

/** The model's rule as validated, "repeats once" being none (capture, the tuned path). */
export const recurrenceFromModel = (
  parsed: QuickAddParse['recurrence'],
  firstDay: string,
): QuickAddPrefill['recurrence'] => {
  const freq = parsed?.count === 1 ? undefined : modelFreq(parsed);
  if (freq === undefined) {
    return undefined;
  }
  const count = positiveInt(parsed?.count);
  const interval = positiveInt(parsed?.interval);
  const untilDate = untilOnOrAfter(realDate(parsed?.untilDate), firstDay);
  return {
    ...(count === undefined ? {} : { count }),
    freq,
    ...(interval === undefined || interval < 2 ? {} : { interval }),
    ...(untilDate === undefined ? {} : { untilDate }),
  };
};

/**
 * A draft placed on its rule's first day: the date moved onto the days
 * the words chose. A rule that ends before that day has nothing to
 * repeat ("every weekday until tomorrow", said on a Saturday): no
 * repeat, the date as it was.
 */
export const startOnRule = (
  date: string,
  recurrence: QuickAddPrefill['recurrence'],
): { readonly date: string; readonly recurrence: QuickAddPrefill['recurrence'] } => {
  const start = firstDayOn(date, recurrence);
  return recurrence?.untilDate !== undefined && recurrence.untilDate < start
    ? { date, recurrence: undefined }
    : { date: start, recurrence };
};

/** One hour on, clamped to the day: the editor works on one date. */
export const addHour = (time: string): string => {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  return hour >= 23
    ? '23:59'
    : `${String(hour + 1).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

/**
 * A captured item's answer as a prefill the editor can open, or why not.
 * The model is trusted only for extraction: every value is re-checked
 * here, because a schema-shaped answer can still be nonsense (23:70, a
 * title of whitespace, an end before its start). The Assistant's tuned
 * path has its own after-code (`tunedResult.ts`).
 */
export const normalizeQuickAdd = (
  parse: QuickAddParse,
  {
    fallbackDate,
    referenceDate,
    timeZone,
  }: {
    /** Used when the answer names no date: the day the user is looking at. */
    fallbackDate?: string | undefined;
    referenceDate: string;
    timeZone: string;
  },
): QuickAddResult => {
  const title = meaningfulText(parse.title);
  if (!title) {
    return { kind: 'rejected', reason: 'No event title was recognised.' };
  }
  const resolvedDate = realDate(parse.date?.trim()) ?? realDate(fallbackDate) ?? referenceDate;
  if (!realDate(resolvedDate)) {
    return { kind: 'rejected', reason: 'That date could not be understood.' };
  }
  const startTime = realTime(parse.startTime);
  const endTime = realTime(parse.endTime);
  // No usable time at all, or the model saying so, is a whole day.
  const isAllDay = !startTime || parse.isAllDay === true;
  const resolvedStart = isAllDay ? '00:00' : startTime;
  // A missing or backwards end becomes a one-hour event rather than an
  // error: "lunch at 1" is a complete thought.
  const resolvedEnd =
    !isAllDay && endTime && endTime > resolvedStart ? endTime : addHour(resolvedStart);
  if (!isAllDay && resolvedEnd <= resolvedStart) {
    // Only reachable in the final minute of the day: the editor puts start
    // and end on one date, so nothing after 23:59 can be expressed.
    return {
      kind: 'rejected',
      reason: 'That would end after midnight — pick an earlier time.',
    };
  }
  const invalid = validateEventDraft(
    {
      calendarKey: 'placeholder:placeholder',
      date: resolvedDate,
      endTime: resolvedEnd,
      isAllDay,
      startTime: resolvedStart,
      title,
    },
    timeZone,
  );
  if (invalid) {
    return { kind: 'rejected', reason: invalid };
  }
  const location = meaningfulText(parse.location);
  // The repeat on the first of its days ("every weekday" read on a Saturday starts on Monday).
  const { date, recurrence } = startOnRule(
    resolvedDate,
    recurrenceFromModel(parse.recurrence, resolvedDate),
  );
  return {
    kind: 'parsed',
    prefill: {
      date,
      endTime: resolvedEnd,
      isAllDay,
      ...(location ? { location } : {}),
      ...(recurrence ? { recurrence } : {}),
      startTime: resolvedStart,
      title,
    },
  };
};
