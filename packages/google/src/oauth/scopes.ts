/**
 * Single source for the OAuth scopes both platforms request — they drifted
 * as two hardcoded copies before. Changing this list forces re-consent for
 * existing accounts on their next sign-in (both platforms already send
 * prompt=consent, and addAccount's email-keyed upsert upgrades an account
 * in place).
 */
export const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';
/** People API: saved contacts (people.connections.list). */
export const CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';
/** People API: "other contacts" — people you've emailed (otherContacts.list). */
export const OTHER_CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.other.readonly';
export const CONTACTS_SCOPES: ReadonlyArray<string> = [CONTACTS_SCOPE, OTHER_CONTACTS_SCOPE];
/** Both contacts scopes granted — the typeahead needs the pair to be useful. */
export const grantsContacts = (scopes: ReadonlyArray<string>): boolean =>
  CONTACTS_SCOPES.every((scope) => scopes.includes(scope));

/**
 * calendars.insert for secondary calendars, nothing else new: a calendar
 * mirror can create its own destination. The app still cannot change or
 * share calendars it did not create.
 */
export const CALENDAR_CREATE_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
/** Whether the account may create calendars — one signed in before the scope was asked for may not. */
export const grantsCalendarCreation = (scopes: ReadonlyArray<string>): boolean =>
  scopes.includes(CALENDAR_CREATE_SCOPE) ||
  scopes.includes('https://www.googleapis.com/auth/calendar');

export const GOOGLE_SCOPES: ReadonlyArray<string> = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  CALENDAR_CREATE_SCOPE,
  TASKS_SCOPE,
  ...CONTACTS_SCOPES,
];

/**
 * The scopes a sign-in asks for. Google Calendar and Google Tasks share
 * one sign-in: the setup's Tasks checkbox only decides whether the tasks
 * scope is on the consent screen (`tasks: false` leaves it out), and the
 * app derives `tasksEnabled` from what was granted either way — ticking
 * it later re-consents in place.
 */
export const googleScopes = ({ tasks }: { readonly tasks: boolean }): ReadonlyArray<string> =>
  tasks ? GOOGLE_SCOPES : GOOGLE_SCOPES.filter((scope) => scope !== TASKS_SCOPE);
