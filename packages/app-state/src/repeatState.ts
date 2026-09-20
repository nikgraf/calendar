import {
  type ByDay,
  type MonthlyOrdinal,
  monthlyOrdinalOf,
  type RecurrenceFrequency,
  type RecurrenceRuleSpec,
  recurrenceLabel,
  sortWeekdays,
  type TaskRecurrence,
  type Weekday,
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

/**
 * The repeat form's state, one object so the pure functions below can be
 * tested without React. Weekdays and the monthly ordinal follow the anchor
 * date until the user (or the seed) names them: only then are the stored
 * values authoritative, so moving the date never pins an untouched rule
 * to the weekday it happened to start on.
 */
export interface RepeatFields {
  readonly count: string;
  readonly ends: RepeatEnds;
  readonly interval: string;
  readonly monthly: MonthlyMode;
  readonly ordinal: MonthlyOrdinal;
  /** The stored ordinal and weekday count (the seed named them, or the user picked). */
  readonly ordinalExplicit: boolean;
  readonly ordinalWeekday: Weekday;
  readonly repeat: RecurrenceFrequency | 'none';
  readonly until: string;
  /** Mon-first; authoritative only while `weekdaysExplicit`, never empty then. */
  readonly weekdays: ReadonlyArray<Weekday>;
  /**
   * The stored weekdays count: the seed named them (a rule Reminders.app
   * stored explicitly is sent back with them, so an untouched Save never
   * rewrites it) or the user toggled one.
   */
  readonly weekdaysExplicit: boolean;
}

/** The anchor's weekday, or undefined while the date field is mid-edit ('' or partial). */
const anchorWeekday = (anchorIso: string): Weekday | undefined => {
  try {
    return weekdayOf(anchorIso);
  } catch {
    return undefined;
  }
};
const anchorOrdinal = (anchorIso: string): MonthlyOrdinal | undefined => {
  try {
    return monthlyOrdinalOf(anchorIso);
  } catch {
    return undefined;
  }
};

/** The form's opening state for a rule (or none). */
export const seedRepeatFields = (seed: RepeatSeed | undefined): RepeatFields => {
  const byDay = seed?.byDay ?? [];
  const monthlyByDay = seed?.freq === 'monthly' ? byDay[0] : undefined;
  const weeklyByDay = seed?.freq === 'weekly' ? byDay.map((day) => day.weekday) : [];
  return {
    count: String(seed?.count ?? 10),
    ends: seed?.count ? 'after' : seed?.untilDate ? 'on' : 'never',
    interval: String(seed?.interval ?? 1),
    monthly: monthlyByDay?.ordinal === undefined ? 'dayOfMonth' : 'weekday',
    ordinal: (monthlyByDay?.ordinal as MonthlyOrdinal | undefined) ?? 1,
    ordinalExplicit: monthlyByDay?.ordinal !== undefined,
    ordinalWeekday: monthlyByDay?.weekday ?? 'MO',
    repeat: seed?.freq ?? 'none',
    until: seed?.untilDate ?? '',
    weekdays: sortWeekdays(weeklyByDay),
    weekdaysExplicit: weeklyByDay.length > 0,
  };
};

/** The weekdays the form shows: the stored ones once explicit, else the anchor's. */
export const shownWeekdays = (fields: RepeatFields, anchorIso: string): ReadonlyArray<Weekday> =>
  fields.weekdaysExplicit ? fields.weekdays : [anchorWeekday(anchorIso) ?? 'MO'];

/** The ordinal weekday the form shows: the stored one once explicit, else the anchor's. */
export const shownOrdinal = (
  fields: RepeatFields,
  anchorIso: string,
): { readonly ordinal: MonthlyOrdinal; readonly weekday: Weekday } =>
  fields.ordinalExplicit
    ? { ordinal: fields.ordinal, weekday: fields.ordinalWeekday }
    : { ordinal: anchorOrdinal(anchorIso) ?? 1, weekday: anchorWeekday(anchorIso) ?? 'MO' };

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
 * weekdays only once they are explicit (RFC 5545 and EventKit default to
 * the start's weekday otherwise); a monthly rule names a weekday only in
 * "weekday" mode.
 */
export const repeatSpecFrom = (
  fields: RepeatFields,
  anchorIso: string,
): TaskRecurrence | undefined => {
  if (fields.repeat === 'none') {
    return undefined;
  }
  const byDay: Array<ByDay> =
    fields.repeat === 'weekly' && fields.weekdaysExplicit
      ? fields.weekdays.map((weekday) => ({ weekday }))
      : fields.repeat === 'monthly' && fields.monthly === 'weekday'
        ? [shownOrdinal(fields, anchorIso)]
        : [];
  return {
    ...(byDay.length > 0 ? { byDay } : {}),
    ...(fields.ends === 'after' ? { count: parseRepeatNumber(fields.count) } : {}),
    freq: fields.repeat,
    interval: parseRepeatNumber(fields.interval),
    ...(fields.ends === 'on' && fields.until ? { untilDate: fields.until } : {}),
  };
};

/** The rule as displayed: the wire spec, with a weekly rule's weekdays always shown. */
export const repeatDisplaySpec = (
  fields: RepeatFields,
  anchorIso: string,
): RecurrenceRuleSpec | undefined => {
  const spec = repeatSpecFrom(fields, anchorIso);
  return spec === undefined || spec.freq !== 'weekly'
    ? spec
    : { ...spec, byDay: shownWeekdays(fields, anchorIso).map((weekday) => ({ weekday })) };
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
  const [fields, setFields] = useState<RepeatFields>(() => seedRepeatFields(seed));
  // Functional updates: a handler may call two setters in one tick (Ends
  // "on date" then seeding "until"), and the second must see the first.
  const update = (
    patch: Partial<RepeatFields> | ((current: RepeatFields) => Partial<RepeatFields>),
  ) =>
    setFields((current) => ({
      ...current,
      ...(typeof patch === 'function' ? patch(current) : patch),
    }));

  const ordinal = shownOrdinal(fields, anchorIso);
  return {
    repeat: fields.repeat,
    repeatCount: fields.count,
    repeatEnds: fields.ends,
    repeatInterval: fields.interval,
    repeatMonthly: fields.monthly,
    repeatOrdinal: ordinal.ordinal,
    repeatOrdinalWeekday: ordinal.weekday,
    /** "Weekly on weekends", for the summary line under the controls; '' when off. */
    repeatSummary: (() => {
      const spec = repeatDisplaySpec(fields, anchorIso);
      return spec === undefined ? '' : recurrenceLabel(spec);
    })(),
    repeatUntil: fields.until,
    repeatWeekdays: shownWeekdays(fields, anchorIso),
    setRepeat: (repeat: RecurrenceFrequency | 'none') => update({ repeat }),
    setRepeatCount: (count: string) => update({ count }),
    setRepeatEnds: (ends: RepeatEnds) => update({ ends }),
    setRepeatInterval: (interval: string) => update({ interval }),
    setRepeatMonthly: (monthly: MonthlyMode) => update({ monthly }),
    // Picking an ordinal or weekday makes both authoritative: the pair
    // stops following the date from then on.
    setRepeatOrdinal: (next: MonthlyOrdinal) =>
      update((current) => ({
        ordinal: next,
        ordinalExplicit: true,
        ordinalWeekday: shownOrdinal(current, anchorIso).weekday,
      })),
    setRepeatOrdinalWeekday: (next: Weekday) =>
      update((current) => ({
        ordinal: shownOrdinal(current, anchorIso).ordinal,
        ordinalExplicit: true,
        ordinalWeekday: next,
      })),
    setRepeatUntil: (until: string) => update({ until }),
    toggleWeekday: (day: Weekday) =>
      update((current) => ({
        weekdays: toggleWeekdayIn(shownWeekdays(current, anchorIso), day),
        weekdaysExplicit: true,
      })),
    toSpec: () => repeatSpecFrom(fields, anchorIso),
  };
};
