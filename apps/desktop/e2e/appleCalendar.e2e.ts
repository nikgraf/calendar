import { type AppleCalendarJson, type AppleEventJson } from '@calendar/apple-calendar';
import {
  Account,
  APPLE_CALENDAR_ACCOUNT_ID,
  Attendee,
  CalendarInfo,
  EventRecord,
} from '@calendar/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  type AppleCalendarFixture,
  type App,
  launchApp,
  readEvents,
  readPendingOps,
} from './harness.ts';

// Apple events are never stored, so they come from the harness's
// in-memory EventKit (CALENDAR_APPLE_CALENDAR=fixture): no TCC prompt and
// no developer calendar is ever read. Times are today, local wall clock.
const at = (hour: number): number => {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
};
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const appleCalendars: ReadonlyArray<AppleCalendarJson> = [
  {
    allowsModifications: true,
    colorHex: '#34c759',
    id: 'ek-home',
    isDefault: true,
    sourceTitle: 'iCloud',
    sourceType: 'calDAV',
    title: 'Home',
    type: 'calDAV',
  },
  {
    allowsModifications: false,
    colorHex: '#ff9500',
    id: 'ek-holidays',
    isDefault: false,
    sourceTitle: 'Subscribed Calendars',
    sourceType: 'subscribed',
    title: 'Holidays',
    type: 'subscription',
  },
];

const appleEvent = (overrides: Partial<AppleEventJson>): AppleEventJson => ({
  calendarId: 'ek-home',
  endUtc: at(11),
  hasRecurrence: false,
  id: 'ek-dentist',
  isAllDay: false,
  isDetached: false,
  startUtc: at(10),
  status: 'confirmed',
  timeZone: zone,
  title: 'Apple dentist',
  updatedAt: 1,
  ...overrides,
});

const fixture: AppleCalendarFixture = {
  calendars: appleCalendars,
  events: [
    { event: appleEvent({}) },
    {
      event: appleEvent({
        calendarId: 'ek-holidays',
        endUtc: at(13),
        id: 'ek-holiday',
        startUtc: at(12),
        title: 'Holiday party',
      }),
    },
  ],
};

const calendar = (overrides: Partial<CalendarInfo>) =>
  new CalendarInfo({
    accessRole: 'owner',
    accountId: 'acc-e2e',
    colorHex: '#4285f4',
    id: 'cal-work',
    isPrimary: true,
    isVisible: true,
    provider: 'google',
    summary: 'Work',
    timeZone: zone,
    ...overrides,
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
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      displayName: 'Apple Calendar',
      email: '',
      id: APPLE_CALENDAR_ACCOUNT_ID,
      provider: 'apple',
      status: 'ok',
      tasksEnabled: false,
    }),
  ],
  calendars: [
    calendar({}),
    ...appleCalendars.map((entry) =>
      calendar({
        accessRole: entry.allowsModifications ? 'owner' : 'reader',
        accountId: APPLE_CALENDAR_ACCOUNT_ID,
        colorHex: entry.colorHex ?? '#1badf8',
        id: entry.id,
        isPrimary: entry.isDefault,
        provider: 'apple',
        sourceTitle: entry.sourceTitle,
        summary: entry.title,
      }),
    ),
  ],
  events: [
    new EventRecord({
      accountId: 'acc-e2e',
      attendees: [
        new Attendee({
          email: 'e2e@example.com',
          isOrganizer: true,
          isSelf: true,
          responseStatus: 'accepted',
        }),
        new Attendee({ email: 'guest@example.com', responseStatus: 'needsAction' }),
      ],
      calendarId: 'cal-work',
      endUtc: at(16),
      etag: '"e1"',
      id: 'gmove1',
      isAllDay: false,
      organizerEmail: 'e2e@example.com',
      startTimeZone: zone,
      startUtc: at(15),
      status: 'confirmed',
      syncedAt: 1,
      syncStatus: 'synced',
      title: 'Google sync',
      updatedAt: 1,
    }),
  ],
};

const setField = (selector: string, value: string, kind: 'input' | 'select') => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  const proto = ${kind === 'input' ? 'window.HTMLInputElement' : 'window.HTMLSelectElement'}.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, ${JSON.stringify(value)});
  element.dispatchEvent(new Event(${JSON.stringify(kind === 'input' ? 'input' : 'change')}, { bubbles: true }));
})()`;

describe('Apple Calendar', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { appleCalendar: { fixture } });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  const open = async (title: string) => {
    await app.cdp.openEditor(`[title^=${JSON.stringify(title)}]`);
  };

  it('shows Apple events and groups the calendars by source', async () => {
    const { cdp } = app;
    expect(await cdp.locate('[title^="Apple dentist"]')).toBeTruthy();
    const sidebar = await cdp.waitFor<string>(`document.querySelector('aside')?.textContent ?? ''`);
    expect(sidebar).toContain('Apple Calendar');
    expect(sidebar).toContain('iCloud');
    expect(sidebar).toContain('Subscribed Calendars');
  });

  it('edits an Apple event with the invitee field disabled and no RSVP', async () => {
    const { cdp } = app;
    await open('Apple dentist');
    try {
      const facts = await cdp.eval<string>(`JSON.stringify({
        calendarEnabled: !document.querySelector('select[aria-label="Calendar"]')?.disabled,
        inviteesDisabled: document.querySelector('input[aria-label="Invitees"]')?.disabled,
        note: document.querySelector('[data-testid="event-invitees-apple"]')?.textContent.includes('add them in Calendar'),
        openCalendar: [...document.querySelectorAll('[data-testid="event-invitees-apple"] button')].some(b => b.textContent?.trim() === 'Open Calendar'),
        rsvp: !!document.querySelector('[aria-label="RSVP"]'),
      })`);
      expect(JSON.parse(facts)).toEqual({
        calendarEnabled: true,
        inviteesDisabled: true,
        note: true,
        openCalendar: true,
        rsvp: false,
      });
      // The button's channel reaches main, which opens nothing under the fixture.
      expect(await cdp.eval(`window.calendarBridge.appleCalendarOpen()`)).toBe(false);
      await cdp.eval(setField('input[placeholder="Title"]', 'Apple dentist (edited)', 'input'));
    } finally {
      await cdp.clickButtonWithText('Save');
    }
    await cdp.waitFor(`!!document.querySelector('[title^="Apple dentist (edited)"]')`);
  });

  it('opens events of a read-only calendar as a viewer', async () => {
    const { cdp } = app;
    await open('Holiday party');
    try {
      expect(await cdp.eval(`!!document.querySelector('[data-testid="event-read-only"]')`)).toBe(
        true,
      );
      expect(
        await cdp.eval(
          `[...document.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Save')`,
        ),
      ).toBe(false);
    } finally {
      await cdp.clickButtonWithText('Cancel');
    }
  });

  it('moves a Google event with a guest to Apple after confirming what is dropped', async () => {
    const { cdp } = app;
    await open('Google sync');
    await cdp.eval(
      setField('select[aria-label="Calendar"]', `${APPLE_CALENDAR_ACCOUNT_ID}:ek-home`, 'select'),
    );
    await cdp.clickButtonWithText('Save');
    const summary = await cdp.waitFor<string>(
      `document.querySelector('[data-testid="move-confirm"]')?.textContent ?? ''`,
    );
    expect(summary).toContain('1 guest');
    await cdp.clickButtonWithText('Move anyway');
    await expect
      .poll(async () => (await readEvents(app.userDataDir)).some((event) => event.id === 'gmove1'))
      .toBe(false);
    const ops = await readPendingOps(app.userDataDir);
    expect(ops.some((op) => op.kind === 'delete' && op.eventId === 'gmove1')).toBe(true);
    // Still on the grid — now read live from the Apple calendar.
    expect(await cdp.locate('[title^="Google sync"]')).toBeTruthy();
  });

  it('moves an Apple event to Google through the queue', async () => {
    const { cdp } = app;
    await open('Apple dentist (edited)');
    await cdp.eval(setField('select[aria-label="Calendar"]', 'acc-e2e:cal-work', 'select'));
    await cdp.clickButtonWithText('Save');
    await expect
      .poll(async () =>
        (await readPendingOps(app.userDataDir)).some(
          (op) => op.kind === 'create' && op.payload?.title === 'Apple dentist (edited)',
        ),
      )
      .toBe(true);
    expect(await cdp.eval(`!!document.querySelector('[data-testid="move-confirm"]')`)).toBe(false);
  });

  it('hides an Apple calendar from the sidebar', async () => {
    const { cdp } = app;
    await cdp.locate('[title^="Google sync"]');
    await cdp.eval(
      `[...document.querySelectorAll('aside button')].find(b => b.textContent?.trim() === 'Home')?.click()`,
    );
    await cdp.waitFor(`!document.querySelector('[title^="Google sync"]')`);
  });
});

/** A plain Apple event to delete, one per attempt of the spec below. */
const errand = (attempt: number, hour: number) => ({
  event: appleEvent({
    endUtc: at(hour + 1),
    id: `ek-errand-${String(attempt)}`,
    startUtc: at(hour),
    title: `Apple errand ${String(attempt)}`,
  }),
});

// The inspector's Delete closes it once the write's reply is back, and
// EventKit can take a while to answer: an event opened meanwhile used to
// close in its place.
describe('A late delete reply meets the next inspector', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, {
      appleCalendar: { fixture: { ...fixture, events: [errand(1, 8), errand(2, 18)] } },
    });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });
  afterEach(async (context) => {
    app.holdEventKitWrites(false);
    if (context.task.result?.state === 'fail') {
      await app.dump(context.task.name);
    }
  });

  const INSPECTOR_TITLE = `document.querySelector('[data-testid="inspector-title"]')?.textContent ?? null`;
  // An event of its own per attempt: a retry finds the first one deleted.
  let attempt = 0;

  it("keeps the next event's inspector open when the last one's delete answers after it opened", async () => {
    const { cdp } = app;
    attempt += 1;
    const doomed = `Apple errand ${String(attempt)}`;
    const block = `document.querySelector(${JSON.stringify(`[title^="${doomed}"]`)})`;
    await cdp.openInspector(`[title^=${JSON.stringify(doomed)}]`);
    await cdp.waitFor<boolean>(`${INSPECTOR_TITLE} === ${JSON.stringify(doomed)}`);
    app.holdEventKitWrites(true);
    await cdp.clickButtonWithText('Delete');
    await cdp.confirmDelete();
    await cdp.openInspector('[title^="Google sync"]');
    await cdp.waitFor<boolean>(`${INSPECTOR_TITLE} === 'Google sync'`);
    // Still held: the next inspector opened before the delete could answer.
    expect(await cdp.eval<boolean>(`!!${block}`)).toBe(true);

    app.holdEventKitWrites(false);
    // The block leaves the grid only once the refresh the write's
    // invalidation asked for is back, and the main process answers that
    // after the delete's own reply: the delete has closed what it closes.
    await cdp.waitFor<boolean>(`!${block}`);
    expect(await cdp.eval<string | null>(INSPECTOR_TITLE)).toBe('Google sync');
  });
});
