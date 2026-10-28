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
  TaskRecord,
  Temporal,
} from '@calendar/core';
import type { GoogleFixture } from '@calendar/sync/testing/googleFixture';
import { afterAll, describe, it } from 'vite-plus/test';
import {
  type App,
  type AppleCalendarFixture,
  launchApp,
  type RemindersFixture,
} from './harness.ts';

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
  email: 'you@example.com',
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
  location?: string,
) => ({
  calendar,
  event: {
    end: { dateTime: isoAt(dayOffset, end[0], end[1] ?? 0), timeZone: ZONE },
    id: `ev-${String(++n)}`,
    ...(location ? { location } : {}),
    start: { dateTime: isoAt(dayOffset, start[0], start[1] ?? 0), timeZone: ZONE },
    status: 'confirmed',
    summary,
  },
});

const googleEvents = [
  gcal('cal-work', 'Team sync', 0, [9], [10]),
  gcal('cal-personal', 'Lunch with Sarah', 0, [13], [14], 'Café Prückel'),
  gcal('cal-work', 'Design review', 1, [10], [11, 30]),
  gcal('cal-personal', 'Deep work', 2, [9], [12]),
  gcal('cal-work', '1:1 with Jonas', 2, [14], [14, 30]),
  gcal('cal-personal', 'Yoga', 2, [18], [19]),
  gcal('cal-work', 'Call with the Tokyo team', 2, [21, 30], [22, 15]),
  gcal('cal-work', 'Standup', 3, [9], [10]),
  gcal('cal-travel', 'Flight to Berlin', 3, [16], [18], 'VIE → BER'),
  gcal('cal-work', 'Workshop', 4, [10], [13]),
  gcal('cal-personal', 'Brunch', 5, [11], [13]),
  gcal('cal-personal', 'Dinner with Lena and Tom', 6, [18], [20]),
];

const google: GoogleFixture = {
  accounts: [{ email: 'you@example.com', id: 'acc-e2e', tasksEnabled: true }],
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
      backgroundColor: '#7898C8',
      id: 'cal-travel',
      summary: 'Travel',
      timeZone: ZONE,
    },
  ],
  events: Object.fromEntries(
    ['cal-personal', 'cal-work', 'cal-travel'].map((id) => [
      id,
      googleEvents.filter((item) => item.calendar === id).map((item) => item.event),
    ]),
  ),
  taskLists: [{ id: 'list-errands', title: 'Errands' }],
  tasks: {
    'list-errands': [
      { due: dueOn(4), id: 't-passport', status: 'needsAction', title: 'Renew passport' },
      { due: dueOn(3), id: 't-hotel', status: 'needsAction', title: 'Book the hotel' },
    ],
  },
};

const appleCalendar: AppleCalendarFixture = {
  calendars: [
    {
      allowsModifications: true,
      colorHex: '#BB7770',
      id: 'ek-family',
      isDefault: true,
      sourceTitle: 'iCloud',
      sourceType: 'calDAV',
      title: 'Family',
      type: 'calDAV',
    },
  ],
  events: [
    {
      event: {
        calendarId: 'ek-family',
        endUtc: at(1, 16),
        hasRecurrence: false,
        id: 'ek-dentist',
        isAllDay: false,
        isDetached: false,
        startUtc: at(1, 15),
        status: 'confirmed',
        timeZone: ZONE,
        title: 'Dentist',
        updatedAt: 1,
      },
    },
    {
      event: {
        calendarId: 'ek-family',
        endUtc: at(4, 17),
        hasRecurrence: false,
        id: 'ek-kids',
        isAllDay: false,
        isDetached: false,
        startUtc: at(4, 16, 30),
        status: 'confirmed',
        timeZone: ZONE,
        title: 'Pick up the kids',
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
      alarms: [],
      completed: true,
      dueDate: day(2),
      id: 'ek-bank',
      listId: 'ek-reminders',
      priority: 0,
      title: 'Call the bank',
      updatedAt: 1,
    },
    {
      alarms: [],
      completed: false,
      dueDate: day(3),
      id: 'ek-pack',
      listId: 'ek-reminders',
      priority: 0,
      title: 'Pack for Berlin',
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
        colorHex: entry.colorHex ?? '#BB7770',
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
  tasks: (reminders.reminders ?? []).map(
    (reminder) =>
      new TaskRecord({
        accountId: APPLE_REMINDERS_ACCOUNT_ID,
        dueDate: reminder.dueDate,
        id: reminder.id,
        listId: reminder.listId,
        provider: 'apple',
        status: reminder.completed ? 'completed' : 'needsAction',
        title: reminder.title,
        updatedAt: 1,
      }),
  ),
};

let app: App | undefined;

afterAll(async () => {
  await app?.stop();
});

describe.skipIf(!OUT)('website screenshots', () => {
  it('captures the week in light and dark', async () => {
    if (!OUT) {
      return;
    }
    mkdirSync(OUT, { recursive: true });
    app = await launchApp(seed, {
      appleCalendar: { fixture: appleCalendar },
      env: { TZ: ZONE },
      google: { fixture: google },
      reminders: { fixture: reminders },
      window: { height: 900, width: 1440 },
    });
    const { cdp } = app;
    for (const text of ['Design review', 'Pack for Berlin', 'Dentist', 'Renew passport']) {
      await cdp.waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`);
    }

    const shoot = async (theme: 'dark' | 'light') => {
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: theme }],
      });
      // A background window takes emulated media only once it draws a frame.
      for (let i = 0; i < 40; i++) {
        await cdp.send('Page.captureScreenshot');
        const applied = (await cdp.send('Runtime.evaluate', {
          expression: `document.documentElement.dataset.theme === ${JSON.stringify(theme)}`,
          returnByValue: true,
        })) as { result: { value: boolean } };
        if (applied.result.value) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
      const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
        data: string;
      };
      writeFileSync(`${OUT}/desktop-${theme}.png`, Buffer.from(shot.data, 'base64'));
    };
    await shoot('light');
    await shoot('dark');
  }, 90_000);
});
