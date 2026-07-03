/**
 * Reactivity invalidation keys. Repo mutations invalidate the specific keys;
 * UI atoms subscribe to them (backend-side invalidations reach the UI runtime
 * through the forwarding bridge — see reactivityForward.ts).
 */
export const ACCOUNTS_KEY = 'accounts';
export const CALENDARS_KEY = 'calendars';
/** Coarse events key: any event change in any calendar. */
export const EVENTS_KEY = 'events';

export const eventsKey = (calendarId: string): string => `events:${calendarId}`;
