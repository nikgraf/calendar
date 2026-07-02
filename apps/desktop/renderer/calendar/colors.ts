import type { CalendarInfo, EventRecord } from '@calendar/core';

export type ColorLookup = (event: EventRecord) => string;

export const makeColorLookup = (calendars: ReadonlyArray<CalendarInfo>): ColorLookup => {
  const byKey = new Map(
    calendars.map((calendar) => [`${calendar.accountId}:${calendar.id}`, calendar.colorHex]),
  );
  return (event) => byKey.get(`${event.accountId}:${event.calendarId}`) ?? '#4285f4';
};

/** Readable foreground for chips sitting on a calendar-colored background. */
export const chipTextColor = (backgroundHex: string): string => {
  const hex = backgroundHex.replace('#', '');
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
  return luminance > 160 ? '#1f2937' : '#ffffff';
};
