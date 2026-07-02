/**
 * Reactivity invalidation keys. Every repo mutation invalidates the specific
 * key(s) plus the coarse 'data' key, which drives the renderer change push.
 */
export const DATA_KEY = 'data';
export const ACCOUNTS_KEY = 'accounts';
export const CALENDARS_KEY = 'calendars';

export const eventsKey = (calendarId: string): string => `events:${calendarId}`;
