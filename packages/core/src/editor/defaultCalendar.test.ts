import { describe, expect, it } from 'vite-plus/test';
import type { NewEventSettings } from '../settingsDocument.ts';
import { Account, APPLE_CALENDAR_ACCOUNT_ID, CalendarInfo } from '../types.ts';
import {
  placeDefaultCalendar,
  portableCalendarRef,
  sameNewEventSettings,
} from './defaultCalendar.ts';

const account = (id: string, email: string, provider: 'apple' | 'google' = 'google') =>
  new Account({
    contactsEnabled: false,
    createdAt: 0,
    email,
    id,
    provider,
    status: 'ok',
    tasksEnabled: false,
  });

const calendar = (
  accountId: string,
  id: string,
  summary: string,
  extra: Partial<Pick<CalendarInfo, 'accessRole' | 'sourceTitle'>> = {},
) =>
  new CalendarInfo({
    accessRole: extra.accessRole ?? 'owner',
    accountId,
    colorHex: '#4285f4',
    id,
    isPrimary: false,
    isVisible: true,
    provider: accountId === APPLE_CALENDAR_ACCOUNT_ID ? 'apple' : 'google',
    ...(extra.sourceTitle === undefined ? {} : { sourceTitle: extra.sourceTitle }),
    summary,
    timeZone: 'Europe/Vienna',
  });

const work = account('acc-work', 'me@example.com');
const apple = account(APPLE_CALENDAR_ACCOUNT_ID, '', 'apple');
const accounts = [work, apple];
const calendars = [
  calendar('acc-work', 'primary', 'me@example.com'),
  calendar('acc-work', 'team', 'Team'),
  calendar('acc-work', 'holidays', 'Holidays', { accessRole: 'reader' }),
  calendar(APPLE_CALENDAR_ACCOUNT_ID, 'ek-family', 'Family', { sourceTitle: 'iCloud' }),
  calendar(APPLE_CALENDAR_ACCOUNT_ID, 'ek-home', 'Home'),
];

const place = (settings: NewEventSettings) =>
  placeDefaultCalendar({ accounts, calendars, settings });

describe('placeDefaultCalendar', () => {
  it('leaves a new event to the calendar used last when none is chosen', () => {
    expect(place({ calendar: 'lastUsed' })).toEqual({ kind: 'lastUsed' });
  });

  it('finds a Google calendar by its account’s email, in any case, and its id', () => {
    expect(
      place({ calendar: { calendarId: 'team', email: 'ME@example.com', kind: 'google' } }),
    ).toEqual({ calendarKey: 'acc-work:team', kind: 'here' });
  });

  it('finds an Apple calendar by source and title, "On My Mac" for one without a source', () => {
    expect(place({ calendar: { kind: 'apple', source: 'iCloud', title: 'Family' } })).toEqual({
      calendarKey: `${APPLE_CALENDAR_ACCOUNT_ID}:ek-family`,
      kind: 'here',
    });
    expect(place({ calendar: { kind: 'apple', source: 'On My Mac', title: 'Home' } })).toEqual({
      calendarKey: `${APPLE_CALENDAR_ACCOUNT_ID}:ek-home`,
      kind: 'here',
    });
  });

  it('names a calendar this device lacks: another account, a gone or read-only calendar', () => {
    expect(
      place({
        calendar: { calendarId: 'team', email: 'other@example.com', kind: 'google', title: 'Team' },
      }),
    ).toEqual({ kind: 'missing', label: 'Team' });
    expect(
      place({ calendar: { calendarId: 'gone', email: 'me@example.com', kind: 'google' } }),
    ).toEqual({ kind: 'missing', label: 'gone' });
    expect(
      place({
        calendar: {
          calendarId: 'holidays',
          email: 'me@example.com',
          kind: 'google',
          title: 'Holidays',
        },
      }),
    ).toEqual({ kind: 'missing', label: 'Holidays' });
    expect(place({ calendar: { kind: 'apple', source: 'iCloud', title: 'Home' } })).toEqual({
      kind: 'missing',
      label: 'Home',
    });
  });

  it('takes neither of two Apple calendars that share the source and title', () => {
    expect(
      placeDefaultCalendar({
        accounts,
        calendars: [
          ...calendars,
          calendar(APPLE_CALENDAR_ACCOUNT_ID, 'ek-family-2', 'Family', { sourceTitle: 'iCloud' }),
        ],
        settings: { calendar: { kind: 'apple', source: 'iCloud', title: 'Family' } },
      }),
    ).toEqual({ kind: 'missing', label: 'Family' });
  });

  it('finds no Apple calendar while Apple Calendar is not connected', () => {
    expect(
      placeDefaultCalendar({
        accounts: [work],
        calendars,
        settings: { calendar: { kind: 'apple', source: 'iCloud', title: 'Family' } },
      }),
    ).toEqual({ kind: 'missing', label: 'Family' });
  });

  it('finds what portableCalendarRef names, for every writable calendar', () => {
    for (const entry of calendars.filter((candidate) => candidate.accessRole === 'owner')) {
      const owner = accounts.find((candidate) => candidate.id === entry.accountId)!;
      const ref = portableCalendarRef(entry, owner)!;
      expect(place({ calendar: ref })).toEqual({
        calendarKey: `${entry.accountId}:${entry.id}`,
        kind: 'here',
      });
    }
  });
});

describe('sameNewEventSettings', () => {
  it('compares the calendar named, not a ref’s title or the email’s case', () => {
    expect(
      sameNewEventSettings(
        {
          calendar: { calendarId: 'team', email: 'me@example.com', kind: 'google', title: 'Team' },
        },
        { calendar: { calendarId: 'team', email: 'Me@Example.com', kind: 'google' } },
      ),
    ).toBe(true);
    expect(
      sameNewEventSettings(
        { calendar: 'lastUsed' },
        { calendar: { calendarId: 'team', email: 'me@example.com', kind: 'google' } },
      ),
    ).toBe(false);
    expect(
      sameNewEventSettings(
        { calendar: { kind: 'apple', source: 'iCloud', title: 'Family' } },
        { calendar: { kind: 'apple', source: 'On My Mac', title: 'Family' } },
      ),
    ).toBe(false);
  });
});
