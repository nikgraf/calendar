// The website's Mac screenshots (apps/web/src/screenshots/desktop-*.webp):
// the fixture week in light and dark, written as PNGs to SHOT_OUT. Skipped
// without it, so the e2e suite never runs it; docs/distribution.md → Website
// has the full recipe, including the iPhone half.
//   pnpm --filter @calendar/desktop build
//   SHOT_OUT=<dir> E2E=1 pnpm exec vp test run apps/desktop/e2e/websiteShots.e2e.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  Account,
  APPLE_CALENDAR_ACCOUNT_ID,
  APPLE_REMINDERS_ACCOUNT_ID,
  CalendarInfo,
  TaskListInfo,
  Temporal,
} from '@calendar/core';
import { mapReminder } from '@calendar/reminders';
import type { GoogleFixture } from '@calendar/sync/testing/googleFixture';
import { describe, expect, it } from 'vite-plus/test';
import { type AppleCalendarFixture, launchApp, type RemindersFixture } from './harness.ts';

const OUT = process.env['SHOT_OUT'];
const ZONE = 'Europe/Vienna';

const today = Temporal.Now.plainDateISO(ZONE);
const monday = today.subtract({ days: today.dayOfWeek - 1 });
const at = (dayOffset: number, hour: number, minute = 0): number =>
  monday.add({ days: dayOffset }).toZonedDateTime({ plainTime: { hour, minute }, timeZone: ZONE })
    .epochMilliseconds;
const isoAt = (dayOffset: number, hour: number, minute = 0): string =>
  new Date(at(dayOffset, hour, minute)).toISOString();
const dueOn = (dayOffset: number): string =>
  `${monday.add({ days: dayOffset }).toString()}T00:00:00.000Z`;
const day = (dayOffset: number): string => monday.add({ days: dayOffset }).toString();

const account = new Account({
  contactsEnabled: false,
  createdAt: 1,
  email: 'alex@example.com',
  id: 'acc-e2e',
  provider: 'google',
  status: 'ok',
  tasksEnabled: true,
});

let n = 0;
const gcal = (
  calendar: string,
  summary: string,
  dayOffset: number,
  start: [number, number?],
  end: [number, number?],
  details?: { location?: string; recurrence?: Array<string> },
) => ({
  calendar,
  event: {
    end: { dateTime: isoAt(dayOffset, end[0], end[1] ?? 0), timeZone: ZONE },
    id: `ev-${String(++n)}`,
    ...details,
    start: { dateTime: isoAt(dayOffset, start[0], start[1] ?? 0), timeZone: ZONE },
    status: 'confirmed',
    summary,
  },
});

const googleEvents = [
  gcal('cal-work', 'Team planning', 0, [9, 30], [10, 15]),
  gcal('cal-work', 'Design review', 0, [13], [14]),
  gcal('cal-family', 'School pickup', 0, [15, 15], [16], {
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR'],
  }),
  gcal('cal-work', 'Focus time', 1, [9, 30], [11], {
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU,TH'],
  }),
  gcal('cal-work', '1:1 with Jonas', 1, [14], [14, 30]),
  gcal('cal-family', 'Swim lesson', 1, [16, 30], [17, 15]),
  gcal('cal-personal', 'Groceries', 1, [17, 30], [18, 15]),
  gcal('cal-work', 'User interviews', 2, [10], [11, 30]),
  gcal('cal-personal', 'Dentist', 2, [13, 15], [14]),
  gcal('cal-personal', 'Yoga', 2, [18], [19]),
  gcal('cal-personal', 'Lunch with Sarah', 3, [12, 15], [13, 15], { location: 'Café Prückel' }),
  gcal('cal-work', 'Budget review', 3, [14], [14, 45]),
  gcal('cal-personal', 'Choir practice', 3, [19, 30], [21]),
  gcal('cal-work', 'Prototype review', 4, [10], [11]),
  gcal('cal-family', 'Lunch at Oma’s', 5, [12], [14]),
];

const google: GoogleFixture = {
  accounts: [{ email: account.email, id: account.id, tasksEnabled: true }],
  calendars: [
    {
      accessRole: 'owner',
      backgroundColor: '#6C9C88',
      id: 'cal-personal',
      primary: true,
      summary: 'Personal',
      timeZone: ZONE,
    },
    {
      accessRole: 'owner',
      backgroundColor: '#9C7BAE',
      id: 'cal-work',
      summary: 'Work',
      timeZone: ZONE,
    },
    {
      accessRole: 'owner',
      backgroundColor: '#BB7770',
      id: 'cal-family',
      summary: 'Family',
      timeZone: ZONE,
    },
  ],
  events: Object.fromEntries(
    ['cal-personal', 'cal-work', 'cal-family'].map((id) => [
      id,
      googleEvents.filter((item) => item.calendar === id).map((item) => item.event),
    ]),
  ),
  taskLists: [{ id: 'list-errands', title: 'Errands' }],
  tasks: {
    'list-errands': [
      { due: dueOn(3), id: 't-library', status: 'needsAction', title: 'Return library books' },
      { due: dueOn(4), id: 't-snacks', status: 'needsAction', title: 'Pack train snacks' },
    ],
  },
};

const appleCalendar: AppleCalendarFixture = {
  calendars: [
    {
      allowsModifications: true,
      colorHex: '#7898C8',
      id: 'ek-travel',
      isDefault: true,
      sourceTitle: 'iCloud',
      sourceType: 'calDAV',
      title: 'Travel',
      type: 'calDAV',
    },
  ],
  events: [
    {
      event: {
        calendarId: 'ek-travel',
        endUtc: at(5, 11, 15),
        hasRecurrence: false,
        id: 'ek-to-linz',
        isAllDay: false,
        isDetached: false,
        startUtc: at(5, 9, 45),
        status: 'confirmed',
        timeZone: ZONE,
        title: 'Train to Linz',
        updatedAt: 1,
      },
    },
    {
      event: {
        calendarId: 'ek-travel',
        endUtc: at(6, 17),
        hasRecurrence: false,
        id: 'ek-to-vienna',
        isAllDay: false,
        isDetached: false,
        startUtc: at(6, 15, 30),
        status: 'confirmed',
        timeZone: ZONE,
        title: 'Train to Vienna',
        updatedAt: 1,
      },
    },
  ],
};

const reminders: RemindersFixture = {
  lists: [
    { allowsModifications: true, colorHex: '#E0943A', id: 'ek-reminders', title: 'Reminders' },
  ],
  reminders: [
    {
      alarms: [0],
      completed: Date.now() >= at(1, 19),
      dueDate: day(1),
      dueTime: '19:00',
      id: 'ek-bins',
      listId: 'ek-reminders',
      priority: 0,
      title: 'Bins out',
      updatedAt: 1,
    },
    {
      alarms: [],
      completed: true,
      dueDate: day(0),
      id: 'ek-tickets',
      listId: 'ek-reminders',
      priority: 0,
      title: 'Book train seats',
      updatedAt: 1,
    },
    {
      alarms: [],
      completed: false,
      dueDate: day(4),
      id: 'ek-form',
      listId: 'ek-reminders',
      priority: 0,
      title: 'Sign the trip form',
      updatedAt: 1,
    },
    {
      alarms: [],
      completed: today.dayOfWeek > 6,
      dueDate: day(5),
      id: 'ek-flowers',
      listId: 'ek-reminders',
      priority: 0,
      title: 'Water flowers',
      updatedAt: 1,
    },
  ],
};

// The Apple sources are mirrored rows plus a read-through, so their account,
// calendar and list rows are seeded as the app would have stored them.
const seed = {
  accounts: [
    account,
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
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      displayName: 'Apple Reminders',
      email: '',
      id: APPLE_REMINDERS_ACCOUNT_ID,
      provider: 'apple',
      status: 'ok',
      tasksEnabled: true,
    }),
  ],
  calendars: appleCalendar.calendars.map(
    (entry) =>
      new CalendarInfo({
        accessRole: 'owner',
        accountId: APPLE_CALENDAR_ACCOUNT_ID,
        colorHex: entry.colorHex ?? '#7898C8',
        id: entry.id,
        isPrimary: entry.isDefault,
        isVisible: true,
        provider: 'apple',
        sourceTitle: entry.sourceTitle,
        summary: entry.title,
        timeZone: ZONE,
      }),
  ),
  events: [],
  taskLists: [
    new TaskListInfo({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      colorHex: '#E0943A',
      id: 'ek-reminders',
      isVisible: true,
      provider: 'apple',
      title: 'Reminders',
    }),
  ],
  tasks: (reminders.reminders ?? []).map((reminder) =>
    mapReminder(reminder, APPLE_REMINDERS_ACCOUNT_ID),
  ),
};

describe.skipIf(!OUT)('website screenshots', () => {
  it('captures the week in light and dark', async ({ onTestFinished }) => {
    if (!OUT) {
      return;
    }
    mkdirSync(OUT, { recursive: true });
    const app = await launchApp(seed, {
      appleCalendar: { fixture: appleCalendar },
      env: { TZ: ZONE },
      google: { fixture: google },
      reminders: { fixture: reminders },
      window: { height: 900, width: 1440 },
    });
    onTestFinished(() => app.stop());
    const { cdp } = app;
    // macOS can clamp the window to the available screen. Keep the
    // captured viewport at the aspect ratio used by the website.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      deviceScaleFactor: 2,
      height: 900,
      mobile: false,
      width: 1440,
    });
    for (const text of [
      'Design review',
      'Book train seats',
      'Train to Linz',
      'Pack train snacks',
    ]) {
      await cdp.waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`);
    }
    // The grid mounts neighbouring days offscreen too. Check this week's
    // seven columns so a duplicate or a pickup on the wrong day fails the capture.
    const pickupCounts = () =>
      cdp.eval<Array<number>>(
        `[...document.querySelectorAll('[data-testid="week-grid"] [data-day]')]
          .filter(column => column.dataset.day >= '${day(0)}' && column.dataset.day <= '${day(6)}')
          .map(column => column.querySelectorAll('[aria-label^="School pickup,"]').length)`,
      );
    await expect.poll(pickupCounts, { timeout: 10_000 }).toEqual([1, 0, 1, 0, 1, 0, 0]);
    await cdp.waitFor(
      `document.querySelector('[data-day="${day(1)}"] [data-testid="timed-task-ek-bins"]')?.title === 'Bins out · 7:00 PM'`,
    );
    await cdp.waitFor(`!!document.querySelector('[data-testid="all-day-task-ek-flowers"]')`);

    const shoot = async (theme: 'dark' | 'light') => {
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: theme }],
      });
      // A background window takes emulated media only once it draws a frame.
      await cdp.waitForRendered(
        `document.documentElement.dataset.theme === ${JSON.stringify(theme)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
        data: string;
      };
      writeFileSync(`${OUT}/desktop-${theme}.png`, Buffer.from(shot.data, 'base64'));
    };
    await shoot('light');
    await shoot('dark');
    writeFileSync(`${OUT}/google.json`, JSON.stringify(google, null, 2));
  }, 90_000);
});
