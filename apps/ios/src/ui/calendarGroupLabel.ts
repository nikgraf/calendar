import type { CalendarInfo } from '@calendar/core';

/** Which account (or, for Apple, which EventKit source) a calendar belongs to. */
export const calendarGroupLabel = (
  calendar: CalendarInfo,
  emailOf: (accountId: string) => string,
): string =>
  calendar.provider === 'apple'
    ? `Apple Calendar · ${calendar.sourceTitle ?? 'This iPhone'}`
    : emailOf(calendar.accountId);
