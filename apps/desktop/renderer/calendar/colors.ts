import type { CalendarInfo, EventRecord } from '@calendar/core';

export type ColorLookup = (event: EventRecord) => string;

export const makeColorLookup = (calendars: ReadonlyArray<CalendarInfo>): ColorLookup => {
  const byKey = new Map(
    calendars.map((calendar) => [`${calendar.accountId}:${calendar.id}`, calendar.colorHex]),
  );
  return (event) => byKey.get(`${event.accountId}:${event.calendarId}`) ?? '#4285f4';
};

/** Readable foreground for chips sitting on a calendar-colored background. */
export { contrastingTextColor as chipTextColor } from '@calendar/core';
