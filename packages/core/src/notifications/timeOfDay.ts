import { Temporal } from '../time/temporal.ts';

/** 'HH:MM' on a local clock as hour and minute; anything unreadable is 09:00. */
export const parseTimeOfDay = (
  time: string,
): { readonly hour: number; readonly minute: number } => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  const hour = match ? Number(match[1]) : Number.NaN;
  const minute = match ? Number(match[2]) : Number.NaN;
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60
    ? { hour, minute }
    : { hour: 9, minute: 0 };
};

/** The instant `date` ('YYYY-MM-DD') reaches `time` ('HH:MM') on the clock of `timeZone`. */
export const timeOfDayToUtc = (date: string, time: string, timeZone: string): number => {
  const { hour, minute } = parseTimeOfDay(time);
  return Temporal.PlainDate.from(date).toZonedDateTime({
    plainTime: new Temporal.PlainTime(hour, minute),
    timeZone,
  }).epochMilliseconds;
};
