import { Temporal, toZonedDateTime } from '@calendar/core';

/**
 * The event editor's pickers, in the primary zone. The model's fields are
 * wall clock in that zone; the native DateTimePicker speaks JS Date and,
 * given `timeZoneName`, shows and returns that instant in the same zone,
 * so a round-trip is exact whatever the device zone. Degenerate strings
 * fall back to now — a picker must never receive an Invalid Date.
 */
export const dateForPicker = (date: string, time: string | undefined, timeZone: string): Date => {
  try {
    return new Date(
      Temporal.PlainDate.from(date).toZonedDateTime({
        plainTime: Temporal.PlainTime.from(time || '09:00'),
        timeZone,
      }).epochMilliseconds,
    );
  } catch {
    return new Date();
  }
};

export const dateStringFromPicker = (value: Date, timeZone: string): string =>
  toZonedDateTime(value.getTime(), timeZone).toPlainDate().toString();

export const timeStringFromPicker = (value: Date, timeZone: string): string =>
  toZonedDateTime(value.getTime(), timeZone).toPlainTime().toString({ smallestUnit: 'minute' });
