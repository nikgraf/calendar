import { type MirrorCalendarRef, mirrorRefKey } from '../mirror/definition.ts';
import { APPLE_DEFAULT_SOURCE, type NewEventSettings } from '../settingsDocument.ts';
import { type Account, type CalendarInfo, isAppleCalendarAccount } from '../types.ts';
import { isCalendarWritable } from './writable.ts';

/**
 * The default calendar of Settings, found among this device's calendars.
 * It is named the portable way (`NewEventSettings`), so the same choice
 * finds Work on the Mac and on the iPhone; a Google calendar is matched by
 * its account's email and its id, an Apple one by source and title.
 */

/** The settings' choice as one string: equal choices give equal keys on every device. */
export const newEventCalendarKey = (calendar: NewEventSettings['calendar']): string =>
  calendar === 'lastUsed' ? calendar : mirrorRefKey(calendar);

/** Whether two settings choose the same calendar (a ref's title and the email's case aside). */
export const sameNewEventSettings = (a: NewEventSettings, b: NewEventSettings): boolean =>
  newEventCalendarKey(a.calendar) === newEventCalendarKey(b.calendar);

/** The EventKit source an Apple calendar is filed under, as the settings document names it. */
const appleSource = (calendar: CalendarInfo): string =>
  calendar.sourceTitle ?? APPLE_DEFAULT_SOURCE;

/** A calendar named the portable way; undefined for an account that is neither Google nor Apple Calendar. */
export const portableCalendarRef = (
  calendar: CalendarInfo,
  account: Account,
): MirrorCalendarRef | undefined => {
  if (isAppleCalendarAccount(account)) {
    return { kind: 'apple', source: appleSource(calendar), title: calendar.summary };
  }
  return account.provider === 'google'
    ? { calendarId: calendar.id, email: account.email, kind: 'google', title: calendar.summary }
    : undefined;
};

/** Where the default calendar is here. */
export type DefaultCalendarPlace =
  /** None chosen: the calendar used last. */
  | { readonly kind: 'lastUsed' }
  /** A calendar here that takes new events, as `accountId:calendarId`. */
  | { readonly calendarKey: string; readonly kind: 'here' }
  /**
   * Chosen, but no calendar here takes it: its account is not on this
   * device, the calendar is gone or read-only, or two Apple calendars
   * share its source and title (which one would be a guess).
   */
  | { readonly kind: 'missing'; readonly label: string };

const labelOf = (ref: MirrorCalendarRef): string =>
  ref.kind === 'google' ? (ref.title ?? ref.calendarId) : ref.title;

/** The calendars here that a ref names (more than one only for Apple twins). */
const matchesOf = (
  ref: MirrorCalendarRef,
  accounts: ReadonlyArray<Account>,
  calendars: ReadonlyArray<CalendarInfo>,
): ReadonlyArray<CalendarInfo> => {
  if (ref.kind === 'google') {
    const email = ref.email.toLowerCase();
    const account = accounts.find(
      (candidate) => candidate.provider === 'google' && candidate.email.toLowerCase() === email,
    );
    return account === undefined
      ? []
      : calendars.filter(
          (calendar) => calendar.accountId === account.id && calendar.id === ref.calendarId,
        );
  }
  const account = accounts.find(isAppleCalendarAccount);
  return account === undefined
    ? []
    : calendars.filter(
        (calendar) =>
          calendar.accountId === account.id &&
          appleSource(calendar) === ref.source &&
          calendar.summary === ref.title,
      );
};

export const placeDefaultCalendar = ({
  accounts,
  calendars,
  settings,
}: {
  readonly accounts: ReadonlyArray<Account>;
  readonly calendars: ReadonlyArray<CalendarInfo>;
  readonly settings: NewEventSettings;
}): DefaultCalendarPlace => {
  const ref = settings.calendar;
  if (ref === 'lastUsed') {
    return { kind: 'lastUsed' };
  }
  const matches = matchesOf(ref, accounts, calendars);
  const [calendar] = matches;
  return matches.length === 1 && calendar !== undefined && isCalendarWritable(calendar)
    ? { calendarKey: `${calendar.accountId}:${calendar.id}`, kind: 'here' }
    : { kind: 'missing', label: labelOf(ref) };
};
