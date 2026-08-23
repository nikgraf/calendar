import {
  Account,
  Attendee,
  CalendarInfo,
  EventRecord,
  TaskListInfo,
  TaskRecord,
} from '@calendar/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type App,
  launchApp,
  readCalendars,
  readEvents,
  readPendingOps,
  readPendingOpsCount,
  readSettings,
  readTasks,
} from './harness.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HOUR_HEIGHT = 48;

/** Today at the given UTC hour. */
const todayAt = (hour: number, minute = 0): number => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute);
};

// The daily series starts three days back so several instances are visible
// in the current week no matter which weekday the suite runs on. All seeded
// hours sit mid-day UTC, so local (CI: UTC, dev: CET/CEST) and UTC dates
// agree and the Monday computed here matches the rendered week.
const dailyStart = todayAt(7) - 3 * DAY_MS;
const mondayAt7 = todayAt(7) - ((new Date().getUTCDay() + 6) % 7) * DAY_MS;
/** Start of the earliest daily-series instance inside the rendered week. */
const firstVisibleDaily = Math.max(dailyStart, mondayAt7);

const account = new Account({
  createdAt: 1,
  email: 'e2e@nikgraf.com',
  id: 'acc-e2e',
  status: 'ok',
  tasksEnabled: true,
});

const calendar = (id: string, summary: string, colorHex: string) =>
  new CalendarInfo({
    accessRole: 'owner',
    accountId: 'acc-e2e',
    colorHex,
    id,
    isPrimary: id === 'cal-work',
    isVisible: true,
    summary,
    timeZone: 'Europe/Vienna',
  });

const timedEvent = (
  id: string,
  calendarId: string,
  title: string,
  startUtc: number,
  endUtc: number,
  extra: Partial<EventRecord> = {},
) =>
  new EventRecord({
    accountId: 'acc-e2e',
    calendarId,
    endUtc,
    etag: '"e2e"',
    id,
    isAllDay: false,
    startTimeZone: 'Europe/Vienna',
    startUtc,
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    title,
    updatedAt: 1,
    ...extra,
  });

const seed = {
  accounts: [account],
  calendars: [
    calendar('cal-work', 'Work', '#3b82f6'),
    calendar('cal-personal', 'Personal', '#22c55e'),
  ],
  events: [
    timedEvent('evt-standup', 'cal-work', 'Standup meeting', todayAt(9), todayAt(10)),
    timedEvent('evt-gym', 'cal-personal', 'Gym session', todayAt(15), todayAt(16)),
    // All-day event today: panning across it must not change the lane height.
    timedEvent('evt-offsite', 'cal-work', 'Team offsite', todayAt(0), todayAt(0) + DAY_MS, {
      endDate: new Date(todayAt(0) + DAY_MS).toISOString().slice(0, 10),
      isAllDay: true,
      startDate: new Date(todayAt(0)).toISOString().slice(0, 10),
      startTimeZone: undefined,
    }),
    timedEvent('evt-daily', 'cal-work', 'Daily sync', dailyStart, dailyStart + 30 * 60 * 1000, {
      recurrence: ['RRULE:FREQ=DAILY;COUNT=14'],
      startTimeZone: 'UTC',
    }),
    timedEvent('evt-review', 'cal-work', 'Design review', todayAt(13), todayAt(14), {
      attendees: [
        new Attendee({
          email: 'organizer@example.com',
          isOrganizer: true,
          responseStatus: 'accepted',
        }),
        new Attendee({ email: 'e2e@nikgraf.com', responseStatus: 'needsAction' }),
      ],
      location: 'https://us02web.zoom.us/j/8881234567?pwd=e2e',
    }),
  ],
  taskLists: [
    new TaskListInfo({ accountId: 'acc-e2e', id: 'list-e2e', isVisible: true, title: 'My Tasks' }),
  ],
  tasks: [
    new TaskRecord({
      accountId: 'acc-e2e',
      dueDate: new Date(todayAt(0)).toISOString().slice(0, 10),
      id: 'task-rent',
      listId: 'list-e2e',
      status: 'needsAction',
      title: 'Pay rent',
      updatedAt: 1,
    }),
  ],
};

let app: App;

beforeAll(async () => {
  app = await launchApp(seed);
}, 60_000);

// Capture diagnostics for whatever failed before the app is torn down.
afterEach(async (context) => {
  if (context.task.result?.state === 'fail') {
    await app?.dump(context.task.name);
  }
});

afterAll(async () => {
  await app?.stop();
});

const eventStart = async (title: string): Promise<number> => {
  const events = await readEvents(app.userDataDir);
  const match = events.find((event) => event.title === title);
  expect(match, `event "${title}" in db`).toBeDefined();
  return match!.startUtc;
};

const eventEnd = async (title: string): Promise<number> => {
  const events = await readEvents(app.userDataDir);
  return events.find((event) => event.title === title)!.endUtc;
};

/** Polls the app database until the predicate matches; returns the match. */
const waitForEvent = async (
  predicate: (event: EventRecord) => boolean,
): Promise<EventRecord | undefined> => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const match = (await readEvents(app.userDataDir)).find(predicate);
    if (match || Date.now() > deadline) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
};

/** Clicks the nth element matching the selector. */
const clickNth = async (selector: string, index: number): Promise<void> => {
  const point = await app.cdp.locate(selector, { index });
  await app.cdp.click(point.x, point.y);
};

/** Types into the editor's title field, React-style. */
const setEditorTitle = async (title: string): Promise<void> => {
  await app.cdp.eval(`(() => {
    const input = document.querySelector('input[placeholder="Title"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(title)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
};

describe('calendar desktop e2e', () => {
  it('renders the seeded week: sidebar, calendars, events', async () => {
    const { cdp } = app;
    await cdp.waitFor(`document.body.textContent.includes('e2e@nikgraf.com')`);
    await cdp.waitFor(`document.body.textContent.includes('Work')`);
    await cdp.waitFor(`!!document.querySelector('[title^="Standup meeting"]')`);
    await cdp.waitFor(`!!document.querySelector('[title^="Gym session"]')`);
    // The recurring master expands to multiple instances across the week.
    const dailyCount = await cdp.eval<number>(
      `document.querySelectorAll('[title^="Daily sync"]').length`,
    );
    expect(dailyCount).toBeGreaterThan(1);
  });

  it('switches views and navigates dates', async () => {
    const { cdp } = app;
    await cdp.clickButtonWithText('month');
    await cdp.waitFor(`document.body.textContent.includes('+') || true`);
    // Month view: weekday header row appears.
    await cdp.waitFor(`document.body.textContent.includes('Mon')`);

    await cdp.clickButtonWithText('day');
    await cdp.waitFor(`!!document.querySelector('[title^="Standup meeting"]')`);

    const titleBefore = await cdp.eval<string>(`document.querySelector('h1')?.textContent ?? ''`);
    await cdp.clickButtonWithText('›');
    const titleAfter = await cdp.waitFor<string>(
      `(document.querySelector('h1')?.textContent ?? '') !== ${JSON.stringify('')} && (document.querySelector('h1')?.textContent ?? '')`,
    );
    expect(titleAfter).not.toBe(titleBefore);
    await cdp.clickButtonWithText('Today');
    await cdp.clickButtonWithText('week');
    await cdp.waitFor(`!!document.querySelector('[title^="Standup meeting"]')`);
  });

  it('navigates days with a horizontal trackpad scroll', async () => {
    const { cdp } = app;
    const h1 = `(document.querySelector('h1')?.textContent ?? '')`;
    const scrollTop = `Math.round(document.querySelector('.overflow-y-scroll')?.scrollTop ?? -1)`;
    // A sustained swipe: enough total deltaX to pan past a full day column
    // (day view columns are viewport-wide), with intra-gesture event gaps.
    const burst = { count: 12, deltaX: 240 };

    // A failure mid-test would leave the view panned weeks away and cascade
    // through every later test — always restore Today + week view.
    try {
      await cdp.clickButtonWithText('day');
      await cdp.waitFor(`!!document.querySelector('[title^="Standup meeting"]')`);
      const point = await cdp.locate('.overflow-y-scroll');

      // Vertical control: scrolls the grid, never navigates.
      const dayTitle = await cdp.eval<string>(h1);
      const scrollBefore = await cdp.eval<number>(scrollTop);
      await cdp.wheel(point.x, point.y, 0, 120);
      await cdp.waitFor(`${scrollTop} !== ${scrollBefore}`);
      expect(await cdp.eval<string>(h1)).toBe(dayTitle);

      // Day view: horizontal pan crosses into another day.
      await cdp.wheelBurst('.overflow-y-scroll', burst);
      await cdp.waitFor(`${h1} !== ${JSON.stringify(dayTitle)}`);

      await cdp.clickButtonWithText('Today');
      await cdp.clickButtonWithText('week');
      const weekTitle = await cdp.waitFor<string>(h1);

      // Week view: horizontal pan slides the rolling 7-day window.
      await cdp.wheelBurst('.overflow-y-scroll', burst);
      await cdp.waitFor(`${h1} !== ${JSON.stringify(weekTitle)}`);

      // No axis dead-lock: a diagonal burst pans days AND scrolls the grid in
      // the same gesture (vertical deltas are applied manually while panning).
      // Scroll upward — the earlier vertical control left scrollTop at max.
      const scrollMid = await cdp.eval<number>(scrollTop);
      const midTitle = await cdp.eval<string>(h1);
      await cdp.wheelBurst('.overflow-y-scroll', { count: 12, deltaX: 240, deltaY: -20 });
      await cdp.waitFor(`${scrollTop} !== ${scrollMid}`);
      await cdp.waitFor(`${h1} !== ${JSON.stringify(midTitle)}`);

      // Today snaps back to the Monday-based week.
      await cdp.clickButtonWithText('Today');
      await cdp.waitFor(`${h1} === ${JSON.stringify(weekTitle)}`);
    } finally {
      // Unconditional restore for the rest of the suite.
      await cdp.clickButtonWithText('Today');
      await cdp.clickButtonWithText('week');
      await cdp
        .waitFor(`!!document.querySelector('[title^="Standup meeting"]')`)
        .catch(() => undefined);
    }
  });

  it('keeps the grid vertically stable and header-aligned while panning', async () => {
    const { cdp } = app;
    // The all-day lane always renders (empty row when no all-day events).
    await cdp.waitFor(`document.body.textContent.includes('all-day')`);
    await cdp.waitFor(`!!document.querySelector('[title="Team offsite"]')`);

    // The lane's height follows its window's row count (task chips share
    // the rows), so a forward pan may legitimately resize it. What must
    // hold: the lane never unmounts mid-pan (the original regression), and
    // a round trip restores the exact geometry — no cumulative drift.
    const gridY = `Math.round(document.querySelector('.overflow-y-scroll').getBoundingClientRect().y)`;
    const yBefore = await cdp.eval<number>(gridY);
    await cdp.wheelBurst('.overflow-y-scroll', { count: 12, deltaX: 240 });
    await cdp.waitFor(`document.body.textContent.includes('all-day')`);
    await cdp.wheelBurst('.overflow-y-scroll', { count: 12, deltaX: -240 });
    const yBack = await cdp.eval<number>(gridY);
    await cdp.clickButtonWithText('Today');
    await cdp.waitFor(`!!document.querySelector('[title^="Standup meeting"]')`);
    const yToday = await cdp.eval<number>(gridY);
    expect(yBack).toBe(yBefore);
    expect(yToday).toBe(yBefore);

    // Day-header columns sit exactly over the body's day columns.
    const maxDrift = await cdp.eval<number>(`(() => {
      const header = document.querySelector('.overflow-hidden > .grid:not(.relative)');
      const body = document.querySelector('.relative.grid');
      let max = 0;
      for (const index of [0, 3, 6, 9]) {
        const headerX = header.children[index].getBoundingClientRect().x;
        const bodyX = body.children[index].getBoundingClientRect().x;
        max = Math.max(max, Math.abs(headerX - bodyX));
      }
      return max;
    })()`);
    expect(maxDrift).toBeLessThanOrEqual(1);
  });

  it('creates an event through the slot-click editor', async () => {
    const { cdp } = app;
    // A free slot: same column as Standup, 3 hours below its block.
    const block = await cdp.locate('[title^="Standup meeting"]');
    await cdp.click(block.x, block.y + 3 * HOUR_HEIGHT + 10);
    await cdp.waitFor(`document.body.textContent.includes('New event')`);
    await cdp.eval(`(() => {
      const input = document.querySelector('input[placeholder="Title"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Coffee chat');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!!document.querySelector('[title^="Coffee chat"]')`);
    expect(await eventStart('Coffee chat')).toBeGreaterThan(0);
  });

  it('edits an event title through the editor', async () => {
    const { cdp } = app;
    const block = await cdp.locate('[title^="Coffee chat"]');
    await cdp.click(block.x, block.y);
    await cdp.waitFor(`document.body.textContent.includes('Edit event')`);
    await cdp.eval(`(() => {
      const input = document.querySelector('input[placeholder="Title"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Coffee chat (moved)');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!!document.querySelector('[title^="Coffee chat (moved)"]')`);
  });

  it('drags an event to a new time and day', async () => {
    const { cdp } = app;
    const before = await eventStart('Standup meeting');
    const from = await cdp.locate('[title^="Standup meeting"]');
    // The day strip is all equal-width day columns (buffer included).
    const dayWidth = await cdp.eval<number>(
      `(() => {
        const strip = document.querySelector('.relative.grid');
        return strip.getBoundingClientRect().width / strip.children.length;
      })()`,
    );
    // Down 2 hours, right 1 day.
    await cdp.drag(from, {
      x: Math.round(from.x + dayWidth),
      y: from.y + 2 * HOUR_HEIGHT,
    });
    const expected = before + 2 * HOUR_MS + 24 * HOUR_MS;
    await cdp.waitFor(`true`);
    const deadline = Date.now() + 10_000;
    let moved = await eventStart('Standup meeting');
    while (moved !== expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      moved = await eventStart('Standup meeting');
    }
    expect(moved).toBe(expected);
  });

  it('drags the bottom handle to resize', async () => {
    const { cdp } = app;
    const before = await eventEnd('Gym session');
    const handle = await cdp.locate('[title^="Gym session"]', {
      atBottom: true,
    });
    await cdp.drag(handle, { x: handle.x, y: handle.y + HOUR_HEIGHT });
    const expected = before + HOUR_MS;
    const deadline = Date.now() + 10_000;
    let resized = await eventEnd('Gym session');
    while (resized !== expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      resized = await eventEnd('Gym session');
    }
    expect(resized).toBe(expected);
  });

  it('cancels a drag with Escape', async () => {
    const { cdp } = app;
    const before = await eventStart('Gym session');
    const from = await cdp.locate('[title^="Gym session"]');
    await cdp.mouse('mousePressed', from.x, from.y);
    for (let step = 1; step <= 5; step += 1) {
      await cdp.mouse('mouseMoved', from.x, from.y + step * 10);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await cdp.pressEscape();
    await cdp.mouse('mouseReleased', from.x, from.y + 50);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await eventStart('Gym session')).toBe(before);
    // The abandoned release must not fall through to a slot click.
    expect(await cdp.eval<boolean>(`document.body.textContent.includes('New event')`)).toBe(false);
  });

  it('drags a recurring instance into a single-instance override', async () => {
    const { cdp } = app;
    const from = await cdp.locate('[title^="Daily sync"]');
    await cdp.drag(from, { x: from.x, y: from.y + 2 * HOUR_HEIGHT });

    const expected = firstVisibleDaily + 2 * HOUR_MS;
    const override = await waitForEvent(
      (event) => event.recurringEventId === 'evt-daily' && event.startUtc === expected,
    );
    expect(override).toBeDefined();
    expect(override!.id).toContain('evt-daily_');
    // The master itself stays untouched.
    const events = await readEvents(app.userDataDir);
    expect(events.find((event) => event.id === 'evt-daily')!.startUtc).toBe(dailyStart);
    // Wait for the override block to render at its new time — the next test
    // clicks it, and a point computed before the re-render goes stale.
    await cdp.waitFor(`(() => {
      const fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
        .format(new Date(${expected}));
      return [...document.querySelectorAll('[title^="Daily sync"]')]
        .some((el) => el.title.includes(fmt));
    })()`);
  });

  it('edits a single occurrence through the editor scope selector', async () => {
    const { cdp } = app;
    // First matching block is the override created by the drag test.
    await clickNth('[title^="Daily sync"]', 0);
    await cdp.waitFor(`document.body.textContent.includes('This and following')`);
    await setEditorTitle('Daily sync (solo)');
    await cdp.clickButtonWithText('Save');

    const override = await waitForEvent((event) => event.title === 'Daily sync (solo)');
    expect(override).toBeDefined();
    expect(override!.recurringEventId).toBe('evt-daily');
    const events = await readEvents(app.userDataDir);
    expect(events.find((event) => event.id === 'evt-daily')!.title).toBe('Daily sync');
  });

  it('renames the whole series with the All events scope', async () => {
    const { cdp } = app;
    // Second matching block is a generated (non-override) instance.
    await clickNth('[title^="Daily sync"]', 1);
    await cdp.waitFor(`document.body.textContent.includes('All events')`);
    await cdp.clickButtonWithText('All events');
    await setEditorTitle('Daily standup');
    await cdp.clickButtonWithText('Save');

    const master = await waitForEvent(
      (event) => event.id === 'evt-daily' && event.title === 'Daily standup',
    );
    expect(master).toBeDefined();
    expect(master!.startUtc).toBe(dailyStart);
    // The detached override keeps its own title.
    await cdp.waitFor(`!!document.querySelector('[title^="Daily sync (solo)"]')`);
  });

  it('splits the series with this-and-following', async () => {
    const { cdp } = app;
    const block = await cdp.locate('[title^="Daily standup"]');
    await cdp.click(block.x, block.y);
    await cdp.waitFor(`document.body.textContent.includes('This and following')`);
    await cdp.clickButtonWithText('This and following');
    await setEditorTitle('Daily standup v2');
    await cdp.clickButtonWithText('Save');

    const newMaster = await waitForEvent(
      (event) => event.title === 'Daily standup v2' && event.recurrence !== undefined,
    );
    expect(newMaster).toBeDefined();
    // The split lands on the 2nd visible instance; earlier occurrences stay
    // with the truncated master.
    const splitStart = firstVisibleDaily + DAY_MS;
    const consumed = (splitStart - dailyStart) / DAY_MS;
    expect(newMaster!.recurrence).toEqual([`RRULE:FREQ=DAILY;COUNT=${14 - consumed}`]);
    expect(newMaster!.startUtc).toBe(splitStart);
    const events = await readEvents(app.userDataDir);
    const truncated = events.find((event) => event.id === 'evt-daily');
    expect(truncated!.recurrence?.[0]).toContain('UNTIL=');
  });

  it('deletes a single occurrence of a series', async () => {
    const { cdp } = app;
    // The previous test asserts the split in the db; wait for the renamed
    // blocks to render before counting them.
    await cdp.waitFor(`document.querySelectorAll('[title^="Daily standup v2"]').length > 0`);
    const countBefore = await cdp.eval<number>(
      `document.querySelectorAll('[title^="Daily standup v2"]').length`,
    );
    const block = await cdp.locate('[title^="Daily standup v2"]');
    await cdp.click(block.x, block.y);
    await cdp.waitFor(`document.body.textContent.includes('This event')`);
    await cdp.clickButtonWithText('Delete');
    // One occurrence vanishes; the master survives.
    await cdp.waitFor(
      `document.querySelectorAll('[title^="Daily standup v2"]').length === ${countBefore - 1}`,
    );
    const events = await readEvents(app.userDataDir);
    expect(events.some((event) => event.title === 'Daily standup v2')).toBe(true);
  });

  it('toggles calendar visibility from the sidebar', async () => {
    const { cdp } = app;
    // Sidebar calendar rows are buttons labelled by summary.
    await cdp.eval(
      `[...document.querySelectorAll('aside button')].find(b => b.textContent?.includes('Personal'))?.click()`,
    );
    await cdp.waitFor(`!document.querySelector('[title^="Gym session"]')`);
    await cdp.eval(
      `[...document.querySelectorAll('aside button')].find(b => b.textContent?.includes('Personal'))?.click()`,
    );
    await cdp.waitFor(`!!document.querySelector('[title^="Gym session"]')`);
  });

  it('deletes an event through the editor', async () => {
    const { cdp } = app;
    const block = await cdp.locate('[title^="Coffee chat (moved)"]');
    await cdp.click(block.x, block.y);
    await cdp.waitFor(`document.body.textContent.includes('Edit event')`);
    await cdp.clickButtonWithText('Delete');
    await cdp.waitFor(`!document.querySelector('[title^="Coffee chat (moved)"]')`);
    const events = await readEvents(app.userDataDir);
    expect(events.some((event) => event.title === 'Coffee chat (moved)')).toBe(false);
  });

  it('creates a recurring event through the repeat picker', async () => {
    const { cdp } = app;
    // A free slot: Gym column (today), 3 hours above the block.
    const block = await cdp.locate('[title^="Gym session"]');
    await cdp.click(block.x, block.y - 3 * HOUR_HEIGHT);
    await cdp.waitFor(`document.body.textContent.includes('New event')`);
    await setEditorTitle('Yoga flow');
    // Pick "Daily", ending after 5 occurrences.
    await cdp.eval(`(() => {
      const setSelect = (label, value) => {
        const select = document.querySelector('select[aria-label="' + label + '"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setSelect('Repeat', 'daily');
      setSelect('Repeat ends', 'after');
    })()`);
    await cdp.eval(`(() => {
      const input = document.querySelector('input[aria-label="Occurrence count"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '5');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.clickButtonWithText('Save');

    const master = await waitForEvent(
      (event) => event.title === 'Yoga flow' && event.recurrence !== undefined,
    );
    expect(master).toBeDefined();
    expect(master!.recurrence).toEqual(['RRULE:FREQ=DAILY;COUNT=5']);
    // The optimistic master expands right away; late-week runs may only
    // have one in-window instance, so assert presence rather than count.
    await cdp.waitFor(`document.querySelectorAll('[title^="Yoga flow"]').length >= 1`);
  });

  it('accepts an invitation through the RSVP buttons', async () => {
    const { cdp } = app;
    const block = await cdp.locate('[title^="Design review"]');
    await cdp.click(block.x, block.y);
    await cdp.waitFor(`document.body.textContent.includes('Invitees')`);
    // The zoom link in the location surfaces as a Join button.
    await cdp.waitFor(
      `[...document.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Join meeting')`,
    );
    await cdp.clickButtonWithText('Accept');

    const updated = await waitForEvent(
      (event) =>
        event.id === 'evt-review' &&
        event.attendees?.find((attendee) => attendee.email === 'e2e@nikgraf.com')
          ?.responseStatus === 'accepted',
    );
    expect(updated).toBeDefined();
    // The organizer's entry stays untouched.
    expect(
      updated!.attendees!.find((attendee) => attendee.email === 'organizer@example.com')!
        .responseStatus,
    ).toBe('accepted');
    await cdp.clickButtonWithText('Cancel');
  });

  it('creates, renames, and deletes a task through the editor', async () => {
    const { cdp } = app;
    // A free slot opens the editor; the toggle switches it to task mode.
    // Anchor on a mid-week block — the first "Standup" match can sit in a
    // clipped buffer column, which would put the new task's due day
    // outside the visible strip.
    const anchor = await cdp.locate('[title^="Design review"]');
    await cdp.click(anchor.x, anchor.y - 4 * HOUR_HEIGHT);
    await cdp.waitFor(`document.body.textContent.includes('New event')`);
    await cdp.clickButtonWithText('Task');
    await cdp.waitFor(`document.body.textContent.includes('New task')`);
    await setEditorTitle('Water plants');
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!!document.querySelector('[title="Water plants"]')`);
    await expect
      .poll(async () => {
        const tasks = await readTasks(app.userDataDir);
        return tasks.find((row) => row.title === 'Water plants')?.id.startsWith('local-');
      })
      .toBe(true);
    const ops = await readPendingOps(app.userDataDir);
    expect(ops.some((op) => op.kind === 'createTask')).toBe(true);

    // Chip body opens task edit; rename.
    const chip = await cdp.locate('[title="Water plants"]');
    // Click the body, away from the leading checkbox.
    await cdp.click(chip.x + 40, chip.y);
    await cdp.waitFor(`document.body.textContent.includes('Edit task')`);
    await setEditorTitle('Water the plants');
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!!document.querySelector('[title="Water the plants"]')`);

    // Delete from the same sheet.
    const renamed = await cdp.locate('[title="Water the plants"]');
    await cdp.click(renamed.x + 40, renamed.y);
    await cdp.waitFor(`document.body.textContent.includes('Edit task')`);
    await cdp.clickButtonWithText('Delete');
    await cdp.waitFor(`!document.querySelector('[title="Water the plants"]')`);
    await expect
      .poll(async () => {
        const tasks = await readTasks(app.userDataDir);
        return tasks.some((row) => row.title === 'Water the plants');
      })
      .toBe(false);
  });

  it('checks a task off from its all-day chip', async () => {
    const { cdp } = app;
    // The chip renders in the all-day lane with the checkbox leading.
    const checkbox = await cdp.locate('[title="Pay rent"] button');
    await cdp.click(checkbox.x, checkbox.y);

    await cdp.waitFor(
      `document.querySelector('[title="Pay rent"]')?.textContent?.includes('☑') === true`,
    );
    // The optimistic write landed and the write-back op is queued.
    await expect
      .poll(async () => {
        const tasks = await readTasks(app.userDataDir);
        return tasks.find((task) => task.id === 'task-rent')?.status;
      })
      .toBe('completed');
    const ops = await readPendingOps(app.userDataDir);
    expect(ops.some((op) => op.kind === 'completeTask' && op.eventId === 'task-rent')).toBe(true);
  });

  it('recolors a calendar through the sidebar picker', async () => {
    const { cdp } = app;
    const point = await cdp.locate('[aria-label="Change color: Personal"]');
    await cdp.click(point.x, point.y);
    await cdp.waitFor(`!!document.querySelector('[aria-label="Set color #16a765"]')`);
    const swatch = await cdp.locate('[aria-label="Set color #16a765"]');
    await cdp.click(swatch.x, swatch.y);

    const deadline = Date.now() + 10_000;
    let personal = (await readCalendars(app.userDataDir)).find(
      (calendar) => calendar.summary === 'Personal',
    );
    while (personal?.colorHex !== '#16a765' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      personal = (await readCalendars(app.userDataDir)).find(
        (calendar) => calendar.summary === 'Personal',
      );
    }
    expect(personal?.colorHex).toBe('#16a765');
    // A write-back op is queued (no Google API in e2e) with the new color.
    const colorOps = (await readPendingOps(app.userDataDir)).filter(
      (op) => op.kind === 'calendarColor',
    );
    expect(colorOps).toHaveLength(1);
    expect(colorOps[0]!.colorHex).toBe('#16a765');
    // The event chip repaints from the calendars atom.
    await cdp.waitFor(
      `(() => { const el = document.querySelector('[title^="Gym session"]'); return el && getComputedStyle(el).backgroundColor === 'rgb(22, 167, 101)'; })()`,
    );
  });

  it('surfaces unsynced changes and discards a stuck op', async () => {
    const { cdp } = app;
    // Every mutation in this suite queued an op (no Google API available).
    const count = await readPendingOpsCount(app.userDataDir);
    expect(count).toBeGreaterThan(0);
    await cdp.waitFor(`document.body.textContent.includes('unsynced change')`);
    await cdp.eval(
      `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('unsynced change'))?.click()`,
    );
    // The discard mutation is fire-and-forget in the UI; re-click if a
    // transient failure swallowed the first attempt.
    const deadline = Date.now() + 12_000;
    let after = count;
    let lastClickAt = 0;
    while (after >= count && Date.now() < deadline) {
      if (Date.now() - lastClickAt > 3000) {
        await cdp.clickButtonWithText('Discard');
        lastClickAt = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      after = await readPendingOpsCount(app.userDataDir);
    }
    expect(after).toBeLessThan(count);
  });

  it('controls screen-sharing privacy from the settings modal', async () => {
    const { cdp } = app;
    await cdp.eval(
      `[...document.querySelectorAll('button')].find(b => b.title === 'Accounts')?.click()`,
    );
    await cdp.waitFor(`document.body.textContent.includes('Add Google Account')`);

    // Hidden is the default and nothing is persisted yet.
    await cdp.waitFor(
      `[...document.querySelectorAll('[role="radio"]')].some(b => b.textContent === 'Hidden' && b.getAttribute('aria-checked') === 'true')`,
    );
    expect(readSettings(app.userDataDir)['screenPrivacy']).toBeUndefined();

    // Always visible persists.
    await cdp.clickButtonWithText('Always visible');
    const deadline = Date.now() + 10_000;
    while (readSettings(app.userDataDir)['screenPrivacy'] !== 'visible' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(readSettings(app.userDataDir)['screenPrivacy']).toBe('visible');

    // The 10-minute pause is runtime-only: mode stays hidden on disk.
    await cdp.clickButtonWithText('Hidden');
    await cdp.clickButtonWithText('Visible for 10 min');
    const state = await cdp.eval<{ mode: string; visibleUntil?: number }>(
      `window.calendarBridge.privacyGet()`,
    );
    expect(state.mode).toBe('hidden');
    expect(state.visibleUntil).toBeGreaterThan(Date.now());
    await cdp.waitFor(`document.body.textContent.includes('min left')`);
    expect(readSettings(app.userDataDir)['screenPrivacy']).toBe('hidden');

    // Back to the default for the remaining flows.
    await cdp.clickButtonWithText('Hidden');
    await cdp.click(20, 400);
    await cdp.waitFor(`!document.body.textContent.includes('Add Google Account')`);
  });

  it('opens and closes the accounts modal', async () => {
    const { cdp } = app;
    await cdp.eval(
      `[...document.querySelectorAll('button')].find(b => b.title === 'Accounts')?.click()`,
    );
    await cdp.waitFor(`document.body.textContent.includes('Add Google Account')`);
    // Close by clicking the overlay backdrop.
    await cdp.click(20, 400);
    await cdp.waitFor(`!document.body.textContent.includes('Add Google Account')`);
  });
  it('moves an event even when no pointermove is delivered', async () => {
    const { cdp } = app;
    // A press and release with nothing in between: the browser coalescing
    // moves under load produced exactly this, silently turning the drag into
    // a click that opened the editor.
    const before = await eventStart('Gym session');
    const from = await cdp.locate('[title^="Gym session"]');
    await cdp.mouse('mousePressed', from.x, from.y);
    await cdp.mouse('mouseReleased', from.x, from.y + HOUR_HEIGHT);

    const expected = before + HOUR_MS;
    const moved = await waitForEvent(
      (event) => event.title === 'Gym session' && event.startUtc === expected,
    );
    expect(moved?.startUtc).toBe(expected);
    expect(await cdp.eval<boolean>(`document.body.textContent.includes('Edit event')`)).toBe(false);
  });
});
