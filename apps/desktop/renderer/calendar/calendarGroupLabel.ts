import type { CalendarInfo } from '@calendar/core';

/** Calendars grouped the way the sidebar shows them: per account, Apple per source. */
export const calendarGroupLabel = (
  calendar: CalendarInfo,
  accountLabel: (accountId: string) => string,
): string =>
  calendar.provider === 'apple'
    ? `Apple Calendar — ${calendar.sourceTitle ?? 'On this Mac'}`
    : accountLabel(calendar.accountId);
