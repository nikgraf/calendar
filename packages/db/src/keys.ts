/**
 * Reactivity invalidation keys. Repo mutations invalidate the specific keys;
 * UI atoms subscribe to them (backend-side invalidations reach the UI runtime
 * through the forwarding bridge — see reactivityForward.ts).
 */
export const ACCOUNTS_KEY = 'accounts';
export const CALENDARS_KEY = 'calendars';
/** Coarse events key: any event change in any calendar. */
export const EVENTS_KEY = 'events';
/** Pending-op queue changes (enqueue/remove/backoff). */
export const OPS_KEY = 'pendingOps';
/** Broadcast when a 412 conflict dropped a local edit (server wins). */
export const CONFLICT_NOTICE_KEY = 'notice:conflict';

export const eventsKey = (calendarId: string): string => `events:${calendarId}`;
