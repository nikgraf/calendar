import {
  Account,
  APPLE_REMINDERS_ACCOUNT_ID,
  CalendarInfo,
  EventRecord,
  TaskListInfo,
  TaskRecord,
} from '@calendar/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  type App,
  launchApp,
  localIsoDaysAgo,
  readEvents,
  readTasks,
  type RemindersFixture,
} from './harness.ts';

// A drag held near the grid's top or bottom edge scrolls the grid, so a
// slot off screen is reachable. Each drop below is computed from where the
// pointer let go and how far the grid had scrolled by then, and checked
// against what the grid showed before the drag.

const HOUR_HEIGHT = 48;
/** Where the grid opens (WeekView): 7:30 at the top. */
const OPEN_SCROLL_TOP = 7.5 * HOUR_HEIGHT;
const isoToday = localIsoDaysAgo(0);
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Today at a local wall-clock hour. */
const todayAt = (hour: number): number => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour).getTime();
};

const event = (id: string, title: string, startHour: number) =>
  new EventRecord({
    accountId: 'acc-e2e',
    calendarId: 'cal-work',
    endUtc: todayAt(startHour + 1),
    etag: '"e2e"',
    id,
    isAllDay: false,
    startTimeZone: zone,
    startUtc: todayAt(startHour),
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    title,
    updatedAt: 1,
  });

const reminder = (id: string, title: string, dueTime?: string) => ({
  alarms: [],
  completed: false,
  dueDate: isoToday,
  ...(dueTime === undefined ? {} : { dueTime }),
  id,
  listId: 'ek-list-1',
  priority: 0,
  title,
  updatedAt: 1,
});

const reminders = [
  reminder('ek-edge-enter', 'Water plants'),
  reminder('ek-edge-lane', 'Buy milk'),
  reminder('ek-edge-timed', 'Call the bank', '10:00'),
];

const seed = {
  accounts: [
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
      colorHex: '#3b82f6',
      id: 'cal-work',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'Work',
      timeZone: zone,
    }),
  ],
  events: [
    event('evt-edge-resize', 'Edge planning', 9),
    event('evt-edge-move', 'Edge lunch', 12),
    event('evt-edge-wheel', 'Edge review', 14),
    event('evt-edge-flick', 'Edge flick', 13),
  ],
  taskLists: [
    new TaskListInfo({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      colorHex: '#ff0000',
      id: 'ek-list-1',
      isVisible: true,
      provider: 'apple',
      title: 'Reminders',
    }),
  ],
  tasks: reminders.map(
    ({ dueTime, id, title }) =>
      new TaskRecord({
        accountId: APPLE_REMINDERS_ACCOUNT_ID,
        dueDate: isoToday,
        ...(dueTime === undefined ? {} : { dueTime }),
        id,
        listId: 'ek-list-1',
        provider: 'apple',
        status: 'needsAction',
        title,
        updatedAt: 1,
      }),
  ),
};

const remindersFixture: RemindersFixture = {
  lists: [{ allowsModifications: true, colorHex: '#ff0000', id: 'ek-list-1', title: 'Reminders' }],
  reminders,
};

interface Grid {
  readonly bottom: number;
  /** The furthest the grid scrolls. */
  readonly max: number;
  readonly scrollTop: number;
  readonly top: number;
}

const SCROLLER = '[data-testid="week-scroller"]';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Minutes as the 15-minute drag step rounds them. */
const snap = (minutes: number) => Math.round(minutes / 15) * 15;
const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
/** The minutes the grid shows from its top down to viewport y. */
const minutesTo = (y: number, grid: Grid) => ((y - grid.top + grid.scrollTop) / HOUR_HEIGHT) * 60;

describe('A drag held at the grid edge scrolls it', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { reminders: { fixture: remindersFixture } });
  }, 60_000);
  afterEach(async (context) => {
    if (context.task.result?.state === 'fail') {
      await app.dump(context.task.name);
      // A failed attempt can leave its chip or block held, and one held at
      // the edge goes on scrolling the grid under the retry: Escape lets go
      // of it without a drop, then the button comes up.
      await app.cdp.pressEscape();
      await app.cdp.mouse('mouseReleased', 1, 1);
    }
  });
  afterAll(async () => {
    await app.stop();
  });

  const grid = () =>
    app.cdp.evaluate(($, selector: string) => {
      const scroller = $.el(selector)!;
      const rect = scroller.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        max: scroller.scrollHeight - scroller.clientHeight,
        scrollTop: scroller.scrollTop,
        top: rect.top,
      };
    }, SCROLLER);
  /** Waits, drawing frames, until the grid's offset (`top`) passes the check: `top <check> bound`. */
  const scrolledUntil = (check: '<=' | '===' | '>=', bound: number) =>
    app.cdp.waitUntilRendered(
      ($, selector: string, op: string, value: number) => {
        const top = $.el(selector)!.scrollTop;
        if (op === '<=') {
          return top <= value;
        }
        if (op === '>=') {
          return top >= value;
        }
        return top === value;
      },
      SCROLLER,
      check,
      bound,
    );
  /** The grid once its offset holds still across a drawn frame: the edge scroll has stopped. */
  const settled = async (): Promise<Grid> => {
    let last = await grid();
    for (let frame = 0; frame < 50; frame += 1) {
      await app.cdp.waitUntilRendered(() => true);
      const next = await grid();
      if (next.scrollTop === last.scrollTop) {
        return next;
      }
      last = next;
    }
    throw new Error('the grid kept scrolling');
  };
  // A lane chip's test measures the grid as it finds it (locating the chip
  // scrolls only the lane), so every test starts where the grid opens, not
  // where the one before it, or a failed attempt of its own, left it: one
  // left at the bottom has nothing below to scroll to. The hook outlasts
  // `waitUntil`'s own wait, so a grid that never shows fails there.
  beforeEach(async () => {
    await app.cdp.waitUntil(
      ($, selector: string, openTop: number) => {
        const scroller = $.el(selector);
        if (scroller) {
          scroller.scrollTop = openTop;
        }
        return !!scroller;
      },
      SCROLLER,
      OPEN_SCROLL_TOP,
    );
    expect((await settled()).scrollTop).toBe(OPEN_SCROLL_TOP);
  }, 20_000);
  /**
   * Waits until the lane has let go of a dropped chip and the grid shows its
   * block. The lane learns of a drop only after the write, so a check of
   * the stored task passes first; until then the lane keeps the chip's row,
   * and once that row goes the grid grows by it and scrolls less far.
   */
  const shownInGrid = (id: string) =>
    app.cdp.waitUntil(
      ($, task: string) =>
        !$.has(`[data-testid="all-day-task-${task}"]`) &&
        $.has(`[data-testid="timed-task-${task}"]`),
      id,
    );
  const taskById = async (id: string) =>
    (await readTasks(app.userDataDir)).find((task) => task.id === id);
  const eventById = async (id: string) =>
    (await readEvents(app.userDataDir)).find((record) => record.id === id);
  // The first EventKit write after launch waits for the bridge to come up.
  const POLL = { timeout: 5000 };

  it('lets a chip from the lane cross the top edge without scrolling, until it has been in the grid', async () => {
    const { cdp } = app;
    const from = await cdp.locate('[data-testid="all-day-task-ek-edge-enter"]');
    const before = await grid();
    expect(before.scrollTop).toBeGreaterThan(2 * HOUR_HEIGHT);
    const inZone = Math.round(before.top) + 8;
    const middle = Math.round((before.top + before.bottom) / 2);
    await cdp.mouse('mousePressed', from.x, from.y);
    await cdp.mouse('mouseMoved', from.x, from.y + 6);
    await cdp.mouse('mouseMoved', from.x, inZone);
    await sleep(500);
    expect((await settled()).scrollTop).toBe(before.scrollTop);
    // Down into the grid and back up: now the edge scrolls.
    await cdp.mouse('mouseMoved', from.x, middle);
    await cdp.mouse('mouseMoved', from.x, inZone);
    await scrolledUntil('<=', before.scrollTop - HOUR_HEIGHT);
    await cdp.mouse('mouseMoved', from.x, middle);
    const after = await settled();
    await cdp.mouse('mouseReleased', from.x, middle);
    await expect
      .poll(() => taskById('ek-edge-enter'), POLL)
      .toMatchObject({ dueDate: isoToday, dueTime: clock(snap(minutesTo(middle, after))) });
    await shownInGrid('ek-edge-enter');
  });

  it('scrolls down while a chip is held at the bottom edge and drops it below what was on screen', async () => {
    const { cdp } = app;
    const from = await cdp.locate('[data-testid="all-day-task-ek-edge-lane"]');
    const before = await grid();
    const shownUntil = minutesTo(before.bottom, before);
    const middle = Math.round((before.top + before.bottom) / 2);
    await cdp.mouse('mousePressed', from.x, from.y);
    await cdp.mouse('mouseMoved', from.x, from.y + 6);
    await cdp.mouse('mouseMoved', from.x, middle);
    await cdp.mouse('mouseMoved', from.x, Math.round(before.bottom) - 2);
    await scrolledUntil('>=', before.max - 1);
    const release = Math.round(before.bottom) - 60;
    await cdp.mouse('mouseMoved', from.x, release);
    const after = await settled();
    await cdp.mouse('mouseReleased', from.x, release);
    const minute = snap(minutesTo(release, after));
    expect(minute).toBeGreaterThan(shownUntil);
    await expect
      .poll(() => taskById('ek-edge-lane'), POLL)
      .toMatchObject({ dueDate: isoToday, dueTime: clock(minute) });
    await shownInGrid('ek-edge-lane');
  });

  it('scrolls up while a timed reminder is held at the top edge and moves it before what was on screen', async () => {
    const { cdp } = app;
    const from = await cdp.locate('[data-testid="timed-task-ek-edge-timed"]');
    const before = await grid();
    expect(before.scrollTop).toBeGreaterThan(2 * HOUR_HEIGHT);
    const shownFrom = minutesTo(before.top, before);
    await cdp.mouse('mousePressed', from.x, from.y);
    await cdp.mouse('mouseMoved', from.x, from.y + 6);
    await cdp.mouse('mouseMoved', from.x, Math.round(before.top) + 2);
    await scrolledUntil('===', 0);
    const release = Math.round(before.top) + 60;
    await cdp.mouse('mouseMoved', from.x, release);
    const after = await settled();
    await cdp.mouse('mouseReleased', from.x, release);
    // A block in the grid moves by the pointer's travel plus the scroll.
    const minute =
      10 * 60 + snap(((release - from.y + after.scrollTop - before.scrollTop) / HOUR_HEIGHT) * 60);
    expect(minute).toBeLessThan(shownFrom);
    await expect
      .poll(() => taskById('ek-edge-timed'), POLL)
      .toMatchObject({ dueDate: isoToday, dueTime: clock(minute) });
  });

  it('moves an event held at the bottom edge past what was on screen', async () => {
    const { cdp } = app;
    const original = (await eventById('evt-edge-move'))!;
    const from = await cdp.locate('[title^="Edge lunch"]');
    const before = await grid();
    const shownUntil = minutesTo(before.bottom, before);
    await cdp.mouse('mousePressed', from.x, from.y);
    await cdp.mouse('mouseMoved', from.x, from.y + 6);
    await cdp.mouse('mouseMoved', from.x, Math.round(before.bottom) - 2);
    await scrolledUntil('>=', before.max - 1);
    const release = Math.round(before.bottom) - 60;
    await cdp.mouse('mouseMoved', from.x, release);
    const after = await settled();
    await cdp.mouse('mouseReleased', from.x, release);
    const deltaMinutes = snap(
      ((release - from.y + after.scrollTop - before.scrollTop) / HOUR_HEIGHT) * 60,
    );
    expect(12 * 60 + deltaMinutes).toBeGreaterThan(shownUntil);
    await expect
      .poll(async () => (await eventById('evt-edge-move'))?.startUtc)
      .toBe(original.startUtc + deltaMinutes * 60_000);
  });

  it('moves an event as far as the wheel scrolls the grid mid-drag', async () => {
    const { cdp } = app;
    const original = (await eventById('evt-edge-wheel'))!;
    const from = await cdp.locate('[title^="Edge review"]');
    const before = await grid();
    expect(before.max - before.scrollTop).toBeGreaterThan(2 * HOUR_HEIGHT);
    await cdp.mouse('mousePressed', from.x, from.y);
    await cdp.mouse('mouseMoved', from.x, from.y + 6);
    await cdp.wheel(from.x, from.y + 6, 0, 2 * HOUR_HEIGHT);
    await scrolledUntil('>=', before.scrollTop + HOUR_HEIGHT);
    const after = await settled();
    await cdp.mouse('mouseReleased', from.x, from.y + 6);
    const deltaMinutes = snap(((6 + after.scrollTop - before.scrollTop) / HOUR_HEIGHT) * 60);
    expect(deltaMinutes).toBeGreaterThanOrEqual(60);
    await expect
      .poll(async () => (await eventById('evt-edge-wheel'))?.startUtc)
      .toBe(original.startUtc + deltaMinutes * 60_000);
  });

  it('scrolls when the first move of a drag already lands at the edge', async () => {
    const { cdp } = app;
    const original = (await eventById('evt-edge-flick'))!;
    const from = await cdp.locate('[title^="Edge flick"]');
    const before = await grid();
    expect(before.max - before.scrollTop).toBeGreaterThan(HOUR_HEIGHT);
    // One coalesced move from the middle of the grid straight into the band:
    // the press itself was clear of the edge.
    await cdp.mouse('mousePressed', from.x, from.y);
    await cdp.mouse('mouseMoved', from.x, Math.round(before.bottom) - 2);
    await scrolledUntil('>=', before.scrollTop + HOUR_HEIGHT);
    const release = Math.round(before.bottom) - 60;
    await cdp.mouse('mouseMoved', from.x, release);
    const after = await settled();
    await cdp.mouse('mouseReleased', from.x, release);
    const deltaMinutes = snap(
      ((release - from.y + after.scrollTop - before.scrollTop) / HOUR_HEIGHT) * 60,
    );
    await expect
      .poll(async () => (await eventById('evt-edge-flick'))?.startUtc)
      .toBe(original.startUtc + deltaMinutes * 60_000);
  });

  it('resizes an event held at the bottom edge past what was on screen', async () => {
    const { cdp } = app;
    const original = (await eventById('evt-edge-resize'))!;
    const handle = await cdp.locate('[title^="Edge planning"]', { atBottom: true });
    const before = await grid();
    const shownUntil = minutesTo(before.bottom, before);
    await cdp.mouse('mousePressed', handle.x, handle.y);
    await cdp.mouse('mouseMoved', handle.x, handle.y + 6);
    await cdp.mouse('mouseMoved', handle.x, Math.round(before.bottom) - 2);
    await scrolledUntil('>=', before.max - 1);
    const release = Math.round(before.bottom) - 60;
    await cdp.mouse('mouseMoved', handle.x, release);
    const after = await settled();
    await cdp.mouse('mouseReleased', handle.x, release);
    const deltaMinutes = snap(
      ((release - handle.y + after.scrollTop - before.scrollTop) / HOUR_HEIGHT) * 60,
    );
    expect(10 * 60 + deltaMinutes).toBeGreaterThan(shownUntil);
    await expect
      .poll(async () => {
        const resized = await eventById('evt-edge-resize');
        return resized && { endUtc: resized.endUtc, startUtc: resized.startUtc };
      })
      .toEqual({ endUtc: original.endUtc + deltaMinutes * 60_000, startUtc: original.startUtc });
  });
});
