/**
 * Single source for the OAuth scopes both platforms request — they drifted
 * as two hardcoded copies before. Changing this list forces re-consent for
 * existing accounts on their next sign-in (both platforms already send
 * prompt=consent, and addAccount's email-keyed upsert upgrades an account
 * in place).
 */
export const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';

export const GOOGLE_SCOPES: ReadonlyArray<string> = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  TASKS_SCOPE,
];
