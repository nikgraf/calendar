import { Account, APPLE_CALENDAR_ACCOUNT_ID, CalendarInfo } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { defaultCalendarChoices, defaultCalendarGroups } from './defaultCalendar.ts';

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
  {
    accessRole = 'owner',
    sourceTitle,
  }: Partial<Pick<CalendarInfo, 'accessRole' | 'sourceTitle'>> = {},
) =>
  new CalendarInfo({
    accessRole,
    accountId,
    colorHex: '#123456',
    id,
    isPrimary: false,
    isVisible: true,
    provider: accountId === APPLE_CALENDAR_ACCOUNT_ID ? 'apple' : 'google',
    ...(sourceTitle === undefined ? {} : { sourceTitle }),
    summary,
    timeZone: 'Europe/Vienna',
  });

const accounts = [
  account('acc', 'me@example.com'),
  account(APPLE_CALENDAR_ACCOUNT_ID, '', 'apple'),
];

describe('defaultCalendarChoices', () => {
  it('offers the writable calendars in list order, each named the portable way', () => {
    const choices = defaultCalendarChoices(accounts, [
      calendar('acc', 'work', 'Work'),
      calendar('acc', 'holidays', 'Holidays', { accessRole: 'reader' }),
      calendar(APPLE_CALENDAR_ACCOUNT_ID, 'ek-1', 'Family', { sourceTitle: 'iCloud' }),
      // A calendar whose account is not (yet) listed has no name to store.
      calendar('acc-gone', 'x', 'Orphan'),
    ]);
    expect(choices.map((choice) => [choice.key, choice.ref, choice.ambiguous])).toEqual([
      [
        'acc:work',
        { calendarId: 'work', email: 'me@example.com', kind: 'google', title: 'Work' },
        false,
      ],
      [
        `${APPLE_CALENDAR_ACCOUNT_ID}:ek-1`,
        { kind: 'apple', source: 'iCloud', title: 'Family' },
        false,
      ],
    ]);
  });

  it('marks Apple calendars that share a source and title, and only those', () => {
    const choices = defaultCalendarChoices(accounts, [
      calendar(APPLE_CALENDAR_ACCOUNT_ID, 'ek-1', 'Family', { sourceTitle: 'iCloud' }),
      calendar(APPLE_CALENDAR_ACCOUNT_ID, 'ek-2', 'Family', { sourceTitle: 'iCloud' }),
      calendar(APPLE_CALENDAR_ACCOUNT_ID, 'ek-3', 'Family'),
      calendar('acc', 'family', 'Family'),
    ]);
    expect(choices.map((choice) => [choice.key, choice.ambiguous])).toEqual([
      [`${APPLE_CALENDAR_ACCOUNT_ID}:ek-1`, true],
      [`${APPLE_CALENDAR_ACCOUNT_ID}:ek-2`, true],
      [`${APPLE_CALENDAR_ACCOUNT_ID}:ek-3`, false],
      ['acc:family', false],
    ]);
  });
});

describe('defaultCalendarGroups', () => {
  it('buckets the choices like the editor’s picker, in first-appearance order', () => {
    const choices = defaultCalendarChoices(accounts, [
      calendar('acc', 'work', 'Work'),
      calendar(APPLE_CALENDAR_ACCOUNT_ID, 'ek-1', 'Family', { sourceTitle: 'iCloud' }),
      calendar('acc', 'home', 'Home'),
    ]);
    const groups = defaultCalendarGroups(choices, (entry) =>
      entry.provider === 'apple' ? `Apple · ${entry.sourceTitle ?? ''}` : entry.accountId,
    );
    expect(groups.map((group) => [group.label, group.choices.map((choice) => choice.key)])).toEqual(
      [
        ['acc', ['acc:work', 'acc:home']],
        ['Apple · iCloud', [`${APPLE_CALENDAR_ACCOUNT_ID}:ek-1`]],
      ],
    );
  });
});
