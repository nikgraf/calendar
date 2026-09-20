import { Schema } from 'effect';
import { Temporal } from '../time/temporal.ts';

/**
 * BYDAY, the one by-part both providers and the editors share: a weekday,
 * optionally with an ordinal (the Nth such weekday of the month, -1 for
 * the last). Lives apart from `types.ts` so the structured rule, the task
 * recurrence and the editor's spec can all use it.
 */
export const Weekday = Schema.Literals(['FR', 'MO', 'SA', 'SU', 'TH', 'TU', 'WE']);
export type Weekday = typeof Weekday.Type;

export const ByDay = Schema.Struct({
  /** Week number for monthly/yearly rules (1…53, -1 = last); absent on weekly rules. */
  ordinal: Schema.optional(Schema.Number),
  weekday: Weekday,
});
export type ByDay = typeof ByDay.Type;

/** The ordinals the editors offer for "the Nth weekday of the month". */
export type MonthlyOrdinal = -1 | 1 | 2 | 3 | 4;
export const MONTHLY_ORDINALS: ReadonlyArray<MonthlyOrdinal> = [1, 2, 3, 4, -1];

/** Picker order: the calendar week starts on Monday. */
export const WEEKDAYS_MONDAY_FIRST: ReadonlyArray<Weekday> = [
  'MO',
  'TU',
  'WE',
  'TH',
  'FR',
  'SA',
  'SU',
];
export const WEEKDAY_CODES: ReadonlySet<string> = new Set(WEEKDAYS_MONDAY_FIRST);

export const WEEKDAY_NAMES: Record<Weekday, { readonly long: string; readonly short: string }> = {
  FR: { long: 'Friday', short: 'Fri' },
  MO: { long: 'Monday', short: 'Mon' },
  SA: { long: 'Saturday', short: 'Sat' },
  SU: { long: 'Sunday', short: 'Sun' },
  TH: { long: 'Thursday', short: 'Thu' },
  TU: { long: 'Tuesday', short: 'Tue' },
  WE: { long: 'Wednesday', short: 'Wed' },
};

export const ORDINAL_NAMES: Record<MonthlyOrdinal, string> = {
  '-1': 'last',
  '1': '1st',
  '2': '2nd',
  '3': '3rd',
  '4': '4th',
};

/** The weekday of a 'YYYY-MM-DD' date. */
export const weekdayOf = (isoDate: string): Weekday =>
  WEEKDAYS_MONDAY_FIRST[Temporal.PlainDate.from(isoDate).dayOfWeek - 1]!;

/**
 * Which "Nth weekday of the month" a date is: 1…4, or -1 when the date is
 * in the month's last seven days (the way "last Friday" is usually meant,
 * even when that Friday is also the fourth).
 */
export const monthlyOrdinalOf = (isoDate: string): MonthlyOrdinal => {
  const date = Temporal.PlainDate.from(isoDate);
  if (date.day > date.daysInMonth - 7) {
    return -1;
  }
  return Math.min(Math.ceil(date.day / 7), 4) as MonthlyOrdinal;
};

const weekdayRank = (weekday: Weekday): number => WEEKDAYS_MONDAY_FIRST.indexOf(weekday);

/** Canonical order: Monday first, then by ordinal. Never mutates its input. */
export const sortByDay = (days: ReadonlyArray<ByDay>): Array<ByDay> =>
  [...days].sort(
    (a, b) =>
      weekdayRank(a.weekday) - weekdayRank(b.weekday) || (a.ordinal ?? 0) - (b.ordinal ?? 0),
  );

/** The BYDAY value: `SA,SU`, `2TU`, `-1FR`. */
export const formatByDay = (days: ReadonlyArray<ByDay>): string =>
  days.map((day) => `${day.ordinal ?? ''}${day.weekday}`).join(',');

/** Order-insensitive equality; absent and empty are the same. */
export const sameByDay = (
  a: ReadonlyArray<ByDay> | undefined,
  b: ReadonlyArray<ByDay> | undefined,
): boolean => formatByDay(sortByDay(a ?? [])) === formatByDay(sortByDay(b ?? []));

export const isWeekend = (days: ReadonlyArray<Weekday>): boolean =>
  days.length === 2 && days.includes('SA') && days.includes('SU');

export const isWeekdays = (days: ReadonlyArray<Weekday>): boolean =>
  days.length === 5 && !days.includes('SA') && !days.includes('SU');

/**
 * The shape a rule's byDay may take, stated once for the editors, the
 * mutation layer and the bridge: weekly rules list plain weekdays; monthly
 * rules name exactly one "Nth weekday"; daily and yearly rules have none.
 * Undefined when valid.
 */
export const byDayError = (spec: {
  readonly byDay?: ReadonlyArray<ByDay> | undefined;
  readonly freq: string;
}): string | undefined => {
  const days = spec.byDay ?? [];
  if (days.length === 0) {
    return undefined;
  }
  switch (spec.freq) {
    case 'weekly':
      return days.some((day) => day.ordinal !== undefined)
        ? 'A weekly rule repeats on plain weekdays, without an ordinal.'
        : undefined;
    case 'monthly': {
      const [day] = days;
      if (days.length !== 1 || day === undefined) {
        return 'A monthly rule repeats on one weekday of the month.';
      }
      return day.ordinal !== undefined &&
        (MONTHLY_ORDINALS as ReadonlyArray<number>).includes(day.ordinal)
        ? undefined
        : 'A monthly weekday rule needs an ordinal: 1st to 4th, or last.';
    }
    default:
      return 'Only weekly and monthly rules repeat on chosen weekdays.';
  }
};
