import { Temporal, validateEventDraft, type RecurrenceFrequency } from '@calendar/core';
import type { QuickAddParse } from './quickAdd.ts';

/** Editor prefill: exactly the fields the shared editor model seeds from. */
export interface QuickAddPrefill {
  readonly date: string;
  readonly endTime: string;
  readonly isAllDay: boolean;
  readonly location?: string;
  /**
   * Recurrence as the editor's own fields, not a built RRULE — the editor
   * shows them and builds the rule itself on save.
   */
  readonly recurrence?: {
    readonly count?: number;
    readonly freq: RecurrenceFrequency;
    readonly interval?: number;
    readonly untilDate?: string;
  };
  readonly startTime: string;
  readonly title: string;
}

export type QuickAddResult =
  | { readonly kind: 'parsed'; readonly prefill: QuickAddPrefill }
  | { readonly kind: 'rejected'; readonly reason: string };

const TIME = /^(\d{1,2}):(\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Small models fill optional string fields with placeholders instead of
 * omitting them — an observed run wrote "unknown" into location for a
 * phrase that never mentioned one.
 */
const PLACEHOLDERS = new Set(['-', 'n/a', 'na', 'none', 'null', 'tbd', 'unknown', 'unspecified']);
const FREQUENCIES = new Set<RecurrenceFrequency>(['daily', 'monthly', 'weekly', 'yearly']);

/** A real calendar date, not merely a date-shaped string ('2026-02-30'). */
const realDate = (value: string | undefined): string | undefined => {
  if (!value || !DATE.test(value)) {
    return undefined;
  }
  try {
    Temporal.PlainDate.from(value, { overflow: 'reject' });
    return value;
  } catch {
    return undefined;
  }
};

const meaningfulText = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text && !PLACEHOLDERS.has(text.toLowerCase()) ? text : undefined;
};

const normalizeTime = (value: string | undefined): string | undefined => {
  const match = value?.trim().match(TIME);
  if (!match) {
    return undefined;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return undefined;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

const addHour = (time: string): string => {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  // Clamp instead of spilling into the next day: the editor works on one date.
  return hour >= 23
    ? '23:59'
    : `${String(hour + 1).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

/**
 * Turns raw model output into a prefill the editor can open, or rejects it.
 *
 * The model is trusted only for extraction; every value is re-checked here,
 * because a schema-shaped answer can still be nonsense (23:70, a title of
 * whitespace, an end before its start).
 */
export const normalizeQuickAdd = (
  parse: QuickAddParse,
  {
    fallbackDate,
    referenceDate,
    timeZone,
  }: {
    /**
     * Used when the phrase named no date — the day the user is looking at,
     * which is not necessarily today. `referenceDate` stays the anchor for
     * relative phrases like "tomorrow".
     */
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

  const startTime = normalizeTime(parse.startTime);
  const endTime = normalizeTime(parse.endTime);
  // No usable time at all means the phrase described a whole day.
  const isAllDay = parse.isAllDay === true || !startTime;
  const resolvedStart = isAllDay ? '00:00' : startTime!;
  // A missing or backwards end becomes a one-hour event rather than an error:
  // "lunch at 1" is a complete thought.
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

  const count = parse.recurrence?.count;
  // "Repeats once" is not a repeat: models attach one to phrases like
  // "next Tuesday", which names a single day.
  const location = meaningfulText(parse.location);
  const parsedFreq = parse.recurrence?.freq;
  const freq = count === 1 || !parsedFreq || !FREQUENCIES.has(parsedFreq) ? undefined : parsedFreq;
  const untilDate = realDate(parse.recurrence?.untilDate);
  const recurrence = freq
    ? {
        ...(typeof count === 'number' && count > 1 ? { count } : {}),
        freq,
        ...(typeof parse.recurrence?.interval === 'number'
          ? { interval: parse.recurrence.interval }
          : {}),
        ...(untilDate ? { untilDate } : {}),
      }
    : undefined;

  return {
    kind: 'parsed',
    prefill: {
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
