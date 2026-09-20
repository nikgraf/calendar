import {
  type ByDay,
  type MonthlyOrdinal,
  monthlyOrdinalOf,
  type RecurrenceFrequency,
  type RecurrenceRuleSpec,
  recurrenceLabel,
  type TaskRecurrence,
  type Weekday,
  WEEKDAYS_MONDAY_FIRST,
  weekdayOf,
} from '@calendar/core';
import { useState } from 'react';

export type RepeatEnds = 'after' | 'never' | 'on';
/** Monthly rules repeat on the anchor's day of the month, or on "the Nth weekday". */
export type MonthlyMode = 'dayOfMonth' | 'weekday';

/** Interval and occurrence count are small positive integers on both backends. */
export const REPEAT_NUMBER_MAX = 999;

/**
 * The interval / count fields are free text; the rule wants a positive
 * integer. Anything else (empty, "3.5", "1e20") reads as 1 rather than
 * reaching a backend — EventKit converts these with trapping casts.
 */
export const parseRepeatNumber = (text: string): number => {
  const value = Number.parseInt(text, 10);
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.min(REPEAT_NUMBER_MAX, value);
};

/** The validation message for a repeat number the form should refuse, or undefined. */
export const repeatNumberError = (text: string, label: string): string | undefined =>
  /^\d+$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= REPEAT_NUMBER_MAX
    ? undefined
    : `${label} must be a whole number between 1 and ${String(REPEAT_NUMBER_MAX)}.`;

/** What a form is seeded from: a task's rule or an event prefill — structurally, so both fit. */
export interface RepeatSeed {
  readonly byDay?: ReadonlyArray<ByDay> | undefined;
  readonly count?: number | undefined;
  readonly freq?: RecurrenceFrequency | undefined;
  readonly interval?: number | undefined;
  readonly untilDate?: string | undefined;
}

/** The repeat form's state, one object so the pure functions below can be tested without React. */
export interface RepeatFields {
  readonly count: string;
  readonly ends: RepeatEnds;
  /**
   * The seed named its weekdays. Such a rule is sent with them even when
   * they equal the anchor's weekday, so an untouched Save never rewrites
   * a rule Reminders.app stored explicitly.
   */
  readonly explicitWeekdays: boolean;
  readonly interval: string;
  readonly monthly: MonthlyMode;
  readonly ordinal: MonthlyOrdinal;
  readonly ordinalWeekday: Weekday;
  readonly repeat: RecurrenceFrequency | 'none';
  readonly until: string;
  /** Mon-first; never empty while weekly. */
  readonly weekdays: ReadonlyArray<Weekday>;
}

const sortWeekdays = (days: ReadonlyArray<Weekday>): ReadonlyArray<Weekday> =>
  WEEKDAYS_MONDAY_FIRST.filter((day) => days.includes(day));

/** The form's opening state for a rule (or none), defaults taken from the anchor date. */
export const seedRepeatFields = (seed: RepeatSeed | undefined, anchorIso: string): RepeatFields => {
  const byDay = seed?.byDay ?? [];
  const monthlyByDay = seed?.freq === 'monthly' ? byDay[0] : undefined;
  const weeklyByDay = seed?.freq === 'weekly' ? byDay.map((day) => day.weekday) : [];
  return {
    count: String(seed?.count ?? 10),
    ends: seed?.count ? 'after' : seed?.untilDate ? 'on' : 'never',
    explicitWeekdays: weeklyByDay.length > 0,
    interval: String(seed?.interval ?? 1),
    monthly: monthlyByDay?.ordinal === undefined ? 'dayOfMonth' : 'weekday',
    ordinal:
      monthlyByDay?.ordinal === undefined
        ? monthlyOrdinalOf(anchorIso)
        : (monthlyByDay.ordinal as MonthlyOrdinal),
    ordinalWeekday: monthlyByDay?.weekday ?? weekdayOf(anchorIso),
    repeat: seed?.freq ?? 'none',
    until: seed?.untilDate ?? '',
    weekdays: weeklyByDay.length > 0 ? sortWeekdays(weeklyByDay) : [weekdayOf(anchorIso)],
  };
};

/** Toggles a weekday, keeping Monday-first order; the last selected day cannot be removed. */
export const toggleWeekdayIn = (
  days: ReadonlyArray<Weekday>,
  day: Weekday,
): ReadonlyArray<Weekday> => {
  if (!days.includes(day)) {
    return sortWeekdays([...days, day]);
  }
  return days.length === 1 ? days : days.filter((existing) => existing !== day);
};

/**
 * The rule the form describes, as both backends accept it, or undefined
 * when repeat is off. The wire stays minimal: a weekly rule names its
 * weekdays only when they differ from the anchor's weekday (RFC 5545 and
 * EventKit default to it) or the seed named them; a monthly rule names a
 * weekday only in "weekday" mode.
 */
export const repeatSpecFrom = (
  fields: RepeatFields,
  anchorIso: string,
): TaskRecurrence | undefined => {
  if (fields.repeat === 'none') {
    return undefined;
  }
  const byDay: Array<ByDay> =
    fields.repeat === 'weekly' &&
    (fields.explicitWeekdays ||
      fields.weekdays.length !== 1 ||
      fields.weekdays[0] !== weekdayOf(anchorIso))
      ? fields.weekdays.map((weekday) => ({ weekday }))
      : fields.repeat === 'monthly' && fields.monthly === 'weekday'
        ? [{ ordinal: fields.ordinal, weekday: fields.ordinalWeekday }]
        : [];
  return {
    ...(byDay.length > 0 ? { byDay } : {}),
    ...(fields.ends === 'after' ? { count: parseRepeatNumber(fields.count) } : {}),
    freq: fields.repeat,
    interval: parseRepeatNumber(fields.interval),
    ...(fields.ends === 'on' && fields.until ? { untilDate: fields.until } : {}),
  };
};

/** The rule as displayed: a weekly rule always shows its weekdays, even when the wire omits them. */
export const repeatDisplaySpec = (fields: RepeatFields): RecurrenceRuleSpec | undefined => {
  if (fields.repeat === 'none') {
    return undefined;
  }
  return {
    ...(fields.repeat === 'weekly'
      ? { byDay: fields.weekdays.map((weekday) => ({ weekday })) }
      : fields.repeat === 'monthly' && fields.monthly === 'weekday'
        ? { byDay: [{ ordinal: fields.ordinal, weekday: fields.ordinalWeekday }] }
        : {}),
    ...(fields.ends === 'after' ? { count: parseRepeatNumber(fields.count) } : {}),
    freq: fields.repeat,
    interval: parseRepeatNumber(fields.interval),
    ...(fields.ends === 'on' && fields.until ? { untilDate: fields.until } : {}),
  };
};

/**
 * The repeat-rule form state shared by the event editor (RRULE for
 * Google, the structured rule for Apple Calendar) and the Reminders form
 * (EKRecurrenceRule) — same chips, same validation, one seed shape.
 * `anchorIso` is the due/start date: switching to weekly starts from its
 * weekday, and the monthly "weekday" mode from its ordinal and weekday.
 * `toSpec()` is the single exit.
 */
export const useRepeatState = (seed: RepeatSeed | undefined, anchorIso: string) => {
  const [fields, setFields] = useState<RepeatFields>(() => seedRepeatFields(seed, anchorIso));
  const update = (patch: Partial<RepeatFields>) => setFields({ ...fields, ...patch });

  return {
    repeat: fields.repeat,
    repeatCount: fields.count,
    repeatEnds: fields.ends,
    repeatInterval: fields.interval,
    repeatMonthly: fields.monthly,
    repeatOrdinal: fields.ordinal,
    repeatOrdinalWeekday: fields.ordinalWeekday,
    /** "Weekly on weekends", for the summary line under the controls; '' when off. */
    repeatSummary: (() => {
      const spec = repeatDisplaySpec(fields);
      return spec === undefined ? '' : recurrenceLabel(spec);
    })(),
    repeatUntil: fields.until,
    repeatWeekdays: fields.weekdays,
    setRepeat: (repeat: RecurrenceFrequency | 'none') =>
      update({
        repeat,
        // A fresh weekly rule starts on the anchor's weekday; a fresh
        // monthly-weekday rule on the anchor's ordinal and weekday.
        ...(repeat === 'weekly' && !fields.explicitWeekdays
          ? { weekdays: [weekdayOf(anchorIso)] }
          : {}),
      }),
    setRepeatCount: (count: string) => update({ count }),
    setRepeatEnds: (ends: RepeatEnds) => update({ ends }),
    setRepeatInterval: (interval: string) => update({ interval }),
    setRepeatMonthly: (monthly: MonthlyMode) =>
      update({
        monthly,
        ...(monthly === 'weekday' && fields.monthly !== 'weekday'
          ? { ordinal: monthlyOrdinalOf(anchorIso), ordinalWeekday: weekdayOf(anchorIso) }
          : {}),
      }),
    setRepeatOrdinal: (ordinal: MonthlyOrdinal) => update({ ordinal }),
    setRepeatOrdinalWeekday: (ordinalWeekday: Weekday) => update({ ordinalWeekday }),
    setRepeatUntil: (until: string) => update({ until }),
    toggleWeekday: (day: Weekday) => update({ weekdays: toggleWeekdayIn(fields.weekdays, day) }),
    toSpec: () => repeatSpecFrom(fields, anchorIso),
  };
};
