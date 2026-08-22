import { Temporal } from './temporal.ts';
import { type EpochMs } from './convert.ts';

export interface UtcRange {
  readonly endUtc: EpochMs;
  readonly startUtc: EpochMs;
}

const startOfDayMs = (date: Temporal.PlainDate, timeZone: string): EpochMs =>
  date.toZonedDateTime({ timeZone }).startOfDay().toInstant().epochMilliseconds;

/** [start of day, start of next day) in the given zone. */
export const dayRange = (date: Temporal.PlainDate, timeZone: string): UtcRange => ({
  endUtc: startOfDayMs(date.add({ days: 1 }), timeZone),
  startUtc: startOfDayMs(date, timeZone),
});

/** [start of `start`, start of `start + dayCount` days) — a rolling multi-day window. */
export const daySpanRange = (
  start: Temporal.PlainDate,
  dayCount: number,
  timeZone: string,
): UtcRange => ({
  endUtc: startOfDayMs(start.add({ days: dayCount }), timeZone),
  startUtc: startOfDayMs(start, timeZone),
});

/** Monday-based week containing `date`. */
export const weekStart = (date: Temporal.PlainDate): Temporal.PlainDate =>
  date.subtract({ days: date.dayOfWeek - 1 });

export interface MonthGridDay {
  readonly date: Temporal.PlainDate;
  readonly inMonth: boolean;
  readonly isToday: boolean;
}

/**
 * The 5–6 Monday-based weeks covering a month, padded with the neighbouring
 * months' days.
 */
export const buildMonthGrid = (
  yearMonth: Temporal.PlainYearMonth,
  today: Temporal.PlainDate,
): Array<Array<MonthGridDay>> => {
  const firstOfMonth = yearMonth.toPlainDate({ day: 1 });
  let cursor = weekStart(firstOfMonth);
  const weeks: Array<Array<MonthGridDay>> = [];

  while (
    Temporal.PlainDate.compare(cursor, yearMonth.toPlainDate({ day: yearMonth.daysInMonth })) <= 0
  ) {
    const week: Array<MonthGridDay> = [];
    for (let index = 0; index < 7; index += 1) {
      week.push({
        date: cursor,
        inMonth: cursor.month === yearMonth.month && cursor.year === yearMonth.year,
        isToday: Temporal.PlainDate.compare(cursor, today) === 0,
      });
      cursor = cursor.add({ days: 1 });
    }
    weeks.push(week);
  }
  return weeks;
};

export const monthGridRange = (
  yearMonth: Temporal.PlainYearMonth,
  today: Temporal.PlainDate,
  timeZone: string,
): UtcRange => {
  const weeks = buildMonthGrid(yearMonth, today);
  const first = weeks[0]![0]!.date;
  const last = weeks.at(-1)![6]!.date;
  return {
    endUtc: startOfDayMs(last.add({ days: 1 }), timeZone),
    startUtc: startOfDayMs(first, timeZone),
  };
};
