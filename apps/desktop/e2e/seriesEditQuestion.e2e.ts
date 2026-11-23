import { Account, CalendarInfo, EventRecord, googleInstanceId, Temporal } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readEvents } from './harness.ts';

// A new start for all events drops the occurrences changed on their own
// (Google cancels them with the PATCH, and the app follows): the editor
// asks before that save. The device zone is pinned so the seeded hours
// are the ones the grid shows on every host.
const TZ = 'Europe/Vienna';
const HOUR_MS = 3_600_000;
const today = Temporal.Now.plainDateISO(TZ);
const at = (daysFromToday: number, hour: number): number =>
  today
    .add({ days: daysFromToday })
    .toZonedDateTime({ plainTime: new Temporal.PlainTime(hour), timeZone: TZ })
    .toInstant().epochMilliseconds;

const series = new EventRecord({
  accountId: 'acc-e2e',
  calendarId: 'cal-e2e',
  endUtc: at(-7, 11),
  etag: '"1"',
  id: 'evt-daily',
  isAllDay: false,
  recurrence: ['RRULE:FREQ=DAILY;COUNT=21'],
  startTimeZone: TZ,
  startUtc: at(-7, 10),
  status: 'confirmed',
  syncedAt: 1,
  syncStatus: 'synced',
  title: 'Daily sync',
  updatedAt: 1,
});
// Today's occurrence, moved to the afternoon and renamed on its own.
const moved = new EventRecord({
  ...series,
  endUtc: at(0, 15),
  etag: '"2"',
  id: googleInstanceId(series.id, at(0, 10), false),
  originalStartUtc: at(0, 10),
  recurrence: undefined,
  recurringEventId: series.id,
  startUtc: at(0, 14),
  title: 'Daily sync with Ada',
});

const seed = {
  accounts: [
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      email: 'e2e@example.com',
      id: 'acc-e2e',
      provider: 'google',
      status: 'ok',
      tasksEnabled: false,
    }),
  ],
  calendars: [
    new CalendarInfo({
      accessRole: 'owner',
      accountId: 'acc-e2e',
      colorHex: '#4285f4',
      id: 'cal-e2e',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'Work',
      timeZone: TZ,
    }),
  ],
  events: [series, moved],
};

const START = '[data-testid="editor"] input[aria-label="Start time"]';
const END = '[data-testid="editor"] input[aria-label="End time"]';
const QUESTION = '[data-testid="move-confirm"]';

describe('The question before a save for all events drops changed occurrences', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { env: { TZ } });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  /** Opens the series from a plain occurrence and gives all events a start an hour later. */
  const retimeAllEvents = async () => {
    const { cdp } = app;
    await cdp.openEditor('[title^="Daily sync"]:not([title^="Daily sync with Ada"])');
    await cdp.clickButtonWithText('All events');
    // The end first: a start at the old end is refused as it is typed.
    await cdp.evaluate(($, end: string) => $.setValue(end, '12:00'), END);
    await cdp.evaluate(($, start: string) => $.setValue(start, '11:00'), START);
    await cdp.clickButtonWithText('Save');
  };

  it('asks nothing when the save keeps every occurrence', async () => {
    const { cdp } = app;
    await cdp.openEditor('[title^="Daily sync"]:not([title^="Daily sync with Ada"])');
    await cdp.clickButtonWithText('All events');
    await cdp.evaluate(
      ($, value: string) => $.setValue('input[placeholder="Location (optional)"]', value),
      'Room 1',
    );
    await cdp.clickButtonWithText('Save');
    // No question: the editor closes, and the changed occurrence is still its own.
    await cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));
    const events = await readEvents(app.userDataDir);
    expect(events.find((event) => event.id === series.id)?.location).toBe('Room 1');
    expect(events.find((event) => event.id === moved.id)?.title).toBe('Daily sync with Ada');
  });

  it('names what goes, and "Keep editing" writes nothing', async () => {
    const { cdp } = app;
    await retimeAllEvents();
    expect(await cdp.waitForValue(($, question: string) => $.text(question), QUESTION)).toContain(
      'Saving this for all events undoes the changes you made to 1 single occurrence.',
    );
    await cdp.clickTestId('move-confirm-no');
    await cdp.waitUntil(($, question: string) => !$.has(question), QUESTION);
    // Still on the form, with the new time in it.
    expect(await cdp.evaluate(($, start: string) => $.value(start), START)).toBe('11:00');
    const events = await readEvents(app.userDataDir);
    expect(events.find((event) => event.id === series.id)?.startUtc).toBe(series.startUtc);
    expect(events.find((event) => event.id === moved.id)?.title).toBe('Daily sync with Ada');
  });

  it('"Save anyway" moves the series and takes the changed occurrence along', async () => {
    const { cdp } = app;
    await cdp.clickButtonWithText('Save');
    await cdp.waitUntil(($, question: string) => $.has(question), QUESTION);
    await cdp.clickTestId('move-confirm-yes');
    await cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));
    await cdp.waitUntil(($) => !$.has('[title^="Daily sync with Ada"]'));
    const events = await readEvents(app.userDataDir);
    expect(events.find((event) => event.id === series.id)?.startUtc).toBe(
      series.startUtc + HOUR_MS,
    );
    expect(events.filter((event) => event.recurringEventId === series.id)).toEqual([]);
  });
});
