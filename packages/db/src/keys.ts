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
/**
 * Broadcast when Google permanently rejected a queued change (a 4xx that
 * retrying cannot fix) and the op was discarded.
 */
export const DROPPED_NOTICE_KEY = 'notice:dropped';

/** Google Tasks: task rows (status/content) changed. */
export const TASKS_KEY = 'tasks';
/** Google Tasks: the set of task lists (or their visibility) changed. */
export const TASKLISTS_KEY = 'taskLists';
/** Contact rows (Google People cache) changed. */
export const CONTACTS_KEY = 'contacts';
/**
 * Birthday rows changed (Google cache or the device snapshot). Separate
 * from CONTACTS_KEY so the invitee typeahead never refetches on a birthday
 * change and vice versa.
 */
export const BIRTHDAYS_KEY = 'birthdays';
/**
 * One device setting changed. Keyed per setting so bookkeeping writes (a
 * reminder scheduler's fired set) never refetch the settings UI.
 */
export const deviceSettingsKey = (key: string): string => `deviceSettings:${key}`;

export const eventsKey = (calendarId: string): string => `events:${calendarId}`;
