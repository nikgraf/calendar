import { Account, CalendarInfo, EventRecord } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, localDayAt } from './harness.ts';

// One shared calendar seen through two signed-in accounts: Google gives
// the calendar and its events the same ids under both, so only the
// account tells the two copies apart. Each block must draw, select and
// open its own account's copy — its color, its permissions. Seeded
// relative to today (local hours) so the blocks are in the week in view.
const HOUR_MS = 60 * 60 * 1000;
const SHARED = 'team@group.calendar.google.com';
const OWNER_COLOR = '#0b8043';
const READER_COLOR = '#d50000';

const account = (id: string, email: string) =>
  new Account({
    contactsEnabled: false,
    createdAt: 1,
    email,
    id,
    provider: 'google',
    status: 'ok',
    tasksEnabled: false,
  });

const calendar = (accountId: string, colorHex: string, accessRole: 'owner' | 'reader') =>
  new CalendarInfo({
    accessRole,
    accountId,
    colorHex,
    id: SHARED,
    isPrimary: false,
    isVisible: true,
    provider: 'google',
    summary: 'Team',
    timeZone: 'UTC',
  });

const copy = (accountId: string) =>
  new EventRecord({
    accountId,
    calendarId: SHARED,
    endUtc: localDayAt(0, 10) + HOUR_MS,
    etag: '"shared"',
    id: 'evt-shared',
    isAllDay: false,
    startTimeZone: 'UTC',
    startUtc: localDayAt(0, 10),
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    title: 'Team sync',
    updatedAt: 1,
  });

const seed = {
  accounts: [
    account('acc-owner', 'owner@example.com'),
    account('acc-reader', 'reader@example.com'),
  ],
  calendars: [
    calendar('acc-owner', OWNER_COLOR, 'owner'),
    calendar('acc-reader', READER_COLOR, 'reader'),
  ],
  events: [copy('acc-owner'), copy('acc-reader')],
};

const BLOCKS = `[...document.querySelectorAll('[role="button"][title^="Team sync"]')]`;
const block = (color: string) => `[role="button"][title^="Team sync"][data-color="${color}"]`;
const READ_ONLY = `!!document.querySelector('[data-testid="event-read-only"]')`;

describe('one calendar under two accounts', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed);
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  it('draws each account’s copy in its own color', async () => {
    await app.cdp.waitFor<boolean>(`${BLOCKS}.length === 2`);
    expect(
      await app.cdp.eval<Array<string>>(`${BLOCKS}.map((el) => el.dataset.color).sort()`),
    ).toEqual([OWNER_COLOR, READER_COLOR].sort());
  });

  it('opens and selects the copy that was clicked, with its own permissions', async () => {
    const { cdp } = app;
    await cdp.openInspector(block(READER_COLOR));
    await cdp.waitFor<boolean>(READ_ONLY);
    expect(
      await cdp.eval<Array<string>>(
        `${BLOCKS}.filter((el) => el.hasAttribute('data-selected')).map((el) => el.dataset.color)`,
      ),
    ).toEqual([READER_COLOR]);

    await cdp.openInspector(block(OWNER_COLOR));
    await cdp.waitFor<boolean>(`!${READ_ONLY}`);
    expect(
      await cdp.eval<boolean>(`!!document.querySelector('[data-testid="inspector-edit"]')`),
    ).toBe(true);
    expect(
      await cdp.eval<Array<string>>(
        `${BLOCKS}.filter((el) => el.hasAttribute('data-selected')).map((el) => el.dataset.color)`,
      ),
    ).toEqual([OWNER_COLOR]);
  });
});
