import { titleFor } from '@calendar/app-state/calendarNavigation';
import {
  Account,
  Attendee,
  CalendarInfo,
  EventRecord,
  TaskListInfo,
  TaskRecord,
  Temporal,
  weekStart,
} from '@calendar/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  type App,
  launchApp,
  localIsoDaysAgo,
  readAccounts,
  readCalendars,
  readEvents,
  readDeviceSetting,
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
/** Today's local ISO date, for date-only records. */
const todayLocalIso = (): string => localIsoDaysAgo(0);
/** The desktop week view's title for a window starting on `first`. */
const weekTitle = (first: Temporal.PlainDate): string => titleFor('week', first, first, 'long');
/** `HH:MM` as minutes since midnight. */
const minuteOfDay = (time: string): number =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

// The daily series starts three days back so several instances are visible
// in the current week no matter which weekday the suite runs on. All seeded
// hours sit mid-day UTC, so local (CI: UTC, dev: CET/CEST) and UTC dates
// agree and the Monday computed here matches the rendered week.
const dailyStart = todayAt(7) - 3 * DAY_MS;
const mondayAt7 = todayAt(7) - ((new Date().getUTCDay() + 6) % 7) * DAY_MS;
/** Start of the earliest daily-series instance inside the rendered week. */
const firstVisibleDaily = Math.max(dailyStart, mondayAt7);
/** Three years back, mid-month: 36 month steps land in it whatever today's day is. */
const YEARS_BACK = 3;
const ancientAt = (hour: number): number => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear() - YEARS_BACK, now.getUTCMonth(), 15, hour);
};

const account = new Account({
  contactsEnabled: false,
  createdAt: 1,
  email: 'e2e@example.com',
  id: 'acc-e2e',
  provider: 'google',
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
    provider: 'google',
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
    // Full history: nothing prunes an event this old any more.
    timedEvent('evt-ancient', 'cal-work', 'Ancient offsite', ancientAt(10), ancientAt(11)),
    timedEvent('evt-review', 'cal-work', 'Design review', todayAt(13), todayAt(14), {
      attendees: [
        new Attendee({
          email: 'organizer@example.com',
          isOrganizer: true,
          responseStatus: 'accepted',
        }),
        new Attendee({ email: 'e2e@example.com', responseStatus: 'needsAction' }),
      ],
      location: 'https://us02web.zoom.us/j/8881234567?pwd=e2e',
    }),
  ],
  taskLists: [
    new TaskListInfo({
      accountId: 'acc-e2e',
      id: 'list-e2e',
      isVisible: true,
      provider: 'google',
      title: 'My Tasks',
    }),
  ],
  tasks: [
    new TaskRecord({
      accountId: 'acc-e2e',
      dueDate: todayLocalIso(),
      id: 'task-rent',
      listId: 'list-e2e',
      provider: 'google',
      status: 'needsAction',
      title: 'Pay rent',
      updatedAt: 1,
    }),
    // Both past days sit inside the rendered strip (two buffer days precede
    // the week), so a chip left on its own day would still be in the DOM.
    new TaskRecord({
      accountId: 'acc-e2e',
      dueDate: localIsoDaysAgo(2),
      id: 'task-overdue',
      listId: 'list-e2e',
      provider: 'google',
      status: 'needsAction',
      title: 'Old chore',
      updatedAt: 1,
    }),
    new TaskRecord({
      accountId: 'acc-e2e',
      completedAt: 1,
      dueDate: localIsoDaysAgo(1),
      id: 'task-done-old',
      listId: 'list-e2e',
      provider: 'google',
      status: 'completed',
      title: 'Done chore',
      updatedAt: 1,
    }),
    // No due day at all (made in Google Tasks): drawn on today until done.
    new TaskRecord({
      accountId: 'acc-e2e',
      id: 'task-undated',
      listId: 'list-e2e',
      provider: 'google',
      status: 'needsAction',
      title: 'Loose end',
      updatedAt: 1,
    }),
  ],
};

let app: App;

beforeAll(async () => {
  app = await launchApp(seed, { captureWatch: 'fixture' });
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

/**
 * Viewport point at a wall-clock time in today's day column, scrolled into
 * view — for drawing slots on grid space no seeded or test event occupies.
 */
const todayGridPoint = async (
  hour: number,
  minute = 0,
  cdp: App['cdp'] = app.cdp,
): Promise<{ x: number; y: number }> => {
  const label = new Date().toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'long',
    weekday: 'long',
  });
  return cdp.eval<{ x: number; y: number }>(`(() => {
    const column = [...document.querySelectorAll('[role="button"][aria-label]')].find((element) =>
      element.getAttribute('aria-label').startsWith(${JSON.stringify(`${label}:`)}),
    );
    const scroller = column.closest('.overflow-y-scroll');
    const offset = (${hour * 60 + minute} / 60) * ${HOUR_HEIGHT};
    scroller.scrollTop = offset - scroller.clientHeight / 2;
    const rect = column.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + offset) };
  })()`);
};

/** The open event editor's start and end time fields. */
const editorTimes = (): Promise<Array<string>> =>
  app.cdp.eval<Array<string>>(
    `[...document.querySelectorAll('input[type="time"]')].map((input) => input.value)`,
  );

/** Whether a window's screen-capture hint is in `phase` (`off`, `capturing` or `after`). */
const captureHintIs = (phase: string): string =>
  `document.querySelector('[data-testid="capture-hint"]')?.dataset.phase === ${JSON.stringify(phase)}`;

describe('calendar desktop e2e', () => {
  it('renders the seeded week: sidebar, calendars, events', async () => {
    const { cdp } = app;
    await cdp.waitFor(`document.body.textContent.includes('e2e@example.com')`);
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
    await cdp.clickTestId('view-month');
    try {
      // Month view: weekday header row appears, and today's cell announces
      // the seeded task. The label, not the chip: today also holds several
      // seeded events, which lead the cell and push the task into "+N more".
      await cdp.waitFor(`document.body.textContent.includes('Mon')`);
      await cdp.waitFor(
        `[...document.querySelectorAll('[data-testid="month-grid"] [role="button"]')].some((cell) => (cell.getAttribute('aria-label') ?? '').includes('1 task'))`,
      );
      // A chip is a real target: it opens its event's inspector, not the day.
      await cdp.openInspector('[data-testid="month-grid"] [data-color]');
      expect(
        await cdp.eval<boolean>(`!!document.querySelector('[data-testid="month-grid"]')`),
      ).toBe(true);
      await cdp.pressEscape();
      await cdp.waitFor(`!document.querySelector('[data-testid="inspector"]')`);
    } finally {
      await cdp.clickTestId('view-day');
    }
    await cdp.waitFor(`!!document.querySelector('[title^="Standup meeting"]')`);

    const titleBefore = await cdp.eval<string>(`document.querySelector('h1')?.textContent ?? ''`);
    await cdp.clickTestId('nav-next');
    const titleAfter = await cdp.waitFor<string>(
      `(document.querySelector('h1')?.textContent ?? '') !== ${JSON.stringify('')} && (document.querySelector('h1')?.textContent ?? '')`,
    );
    expect(titleAfter).not.toBe(titleBefore);
    await cdp.clickButtonWithText('Today');
    await cdp.clickTestId('view-week');
    await cdp.waitFor(`!!document.querySelector('[title^="Standup meeting"]')`);
  });

  it('renders an event three years back in the month view', async () => {
    const { cdp } = app;
    await cdp.clickTestId('view-month');
    await cdp.waitFor(`document.body.textContent.includes('Mon')`);
    try {
      for (let step = 0; step < 12 * YEARS_BACK; step += 1) {
        const before = await cdp.eval<string>(`document.querySelector('h1')?.textContent ?? ''`);
        await cdp.clickTestId('nav-prev');
        await cdp.waitFor(
          `(document.querySelector('h1')?.textContent ?? '') !== ${JSON.stringify(before)}`,
        );
      }
      await cdp.waitFor(`document.body.textContent.includes('Ancient offsite')`);
    } finally {
      await cdp.clickButtonWithText('Today');
      await cdp.clickTestId('view-week');
      await cdp.waitFor(`!!document.querySelector('[title^="Standup meeting"]')`);
    }
  });

  it('runs the built renderer under the content security policy', async () => {
    // The e2e app loads dist/index.html from file://, as the packaged app
    // does. An inline script must not run under script-src 'self'. (Not
    // eval: CDP's own evaluation is exempt from the page's policy.)
    const inlineRan = await app.cdp.eval<boolean>(`(() => {
      delete window.__cspProbe;
      const probe = document.createElement('script');
      probe.textContent = 'window.__cspProbe = true';
      document.head.append(probe);
      probe.remove();
      return window.__cspProbe === true;
    })()`);
    expect(inlineRan).toBe(false);
  });

  it('loads the dictation worklet under that policy', async () => {
    // Where desktopSpeech.ts loads it from; a blob: worklet was blocked
    // here, so dictation failed in every built app.
    const loaded = await app.cdp.eval<string>(`(async () => {
      const context = new AudioContext();
      try {
        await context.audioWorklet.addModule(
          new URL('pcm-collector.worklet.js', document.baseURI).href,
        );
        new AudioWorkletNode(context, 'pcm-collector');
        return 'loaded';
      } catch (error) {
        return String(error);
      } finally {
        void context.close();
      }
    })()`);
    expect(loaded).toBe('loaded');
  });

  it('shows the history import status under the account', async () => {
    const settings = await app.openSettings('accounts');
    // Seeded rows and no sync_state: nothing is importing, so the line
    // reads complete.
    await settings.waitFor(
      `document.querySelector('[data-testid="sync-history-acc-e2e"]')?.textContent === 'History complete'`,
    );
    await app.closeSettings();
  });

  it('asks before removing a Google account, and Cancel keeps it', async () => {
    const settings = await app.openSettings('accounts');
    try {
      const remove = await settings.locate('[data-testid="remove-account-acc-e2e"]');
      await settings.click(remove.x, remove.y);
      await settings.waitFor(
        `document.querySelector('[data-testid="remove-account-confirm"]')?.textContent.includes('Remove e2e@example.com?')`,
      );
      await settings.clickButtonWithText('Cancel');
      await settings.waitFor(`!document.querySelector('[data-testid="remove-account-confirm"]')`);
      expect((await readAccounts(app.userDataDir)).map((account) => account.id)).toContain(
        'acc-e2e',
      );
    } finally {
      await app.closeSettings();
    }
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
      await cdp.clickTestId('view-day');
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
      await cdp.clickTestId('view-week');
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
      await cdp.clickTestId('view-week');
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

  it('highlights the days the week shows and slides a picked mini-month day to the front', async () => {
    const { cdp } = app;
    const h1 = `(document.querySelector('h1')?.textContent ?? '')`;
    const panX = `document.querySelector('[data-testid="week-view"]').style.getPropertyValue('--pan-x')`;
    const columns = `document.querySelector('[data-testid="week-grid"]').style.gridTemplateColumns`;
    const monday = weekStart(Temporal.PlainDate.from(todayLocalIso()));
    /** The window a week title names: titles are unique per first day. */
    const windowStartOf = (title: string): Temporal.PlainDate => {
      for (let offset = -60; offset <= 60; offset += 1) {
        const first = monday.add({ days: offset });
        if (weekTitle(first) === title) {
          return first;
        }
      }
      throw new Error(`no window is titled ${title}`);
    };
    const miniDays = (filter: string) =>
      cdp.eval<Array<string>>(
        `[...document.querySelectorAll('[data-testid^="mini-day-"]${filter}')].map((day) => day.dataset.testid.slice('mini-day-'.length))`,
      );
    /** The highlight is the window's days the shown month holds — a rolled week crosses two rows. */
    const expectHighlight = async (first: Temporal.PlainDate) => {
      const shown = new Set(await miniDays(''));
      const window = Array.from({ length: 7 }, (_, index) => first.add({ days: index }).toString());
      const expected = window.filter((day) => shown.has(day));
      expect(expected.length).toBeGreaterThan(0);
      expect(await miniDays('[data-in-view]')).toEqual(expected);
    };
    /** Records every `--pan-x` the week view is given from now on. */
    const watchOffsets = () =>
      cdp.eval(`(() => {
        const root = document.querySelector('[data-testid="week-view"]');
        window.__offsets = [];
        window.__offsetObserver?.disconnect();
        window.__offsetObserver = new MutationObserver(() =>
          window.__offsets.push(parseFloat(root.style.getPropertyValue('--pan-x')) || 0));
        window.__offsetObserver.observe(root, { attributeFilter: ['style'], attributes: true });
      })()`);
    /** Picks a mini-month day and waits for its slide to end: the strip is back to 11 columns. */
    const pick = async (day: Temporal.PlainDate): Promise<Array<number>> => {
      await watchOffsets();
      await cdp.clickTestId(`mini-day-${day.toString()}`);
      await cdp.waitFor(`${h1} === ${JSON.stringify(weekTitle(day))}`);
      await cdp.waitFor(`${columns} === 'repeat(11, 1fr)'`);
      await cdp.waitFor(`${panX} === '0px'`);
      return cdp.eval<Array<number>>('window.__offsets');
    };
    const reducedMotion = async (value: 'no-preference' | 'reduce') => {
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value }],
      });
      // A background window takes emulated media only once it draws a frame.
      await cdp.send('Page.captureScreenshot');
      await cdp.waitFor(`matchMedia('(prefers-reduced-motion: ${value})').matches`);
    };

    try {
      await reducedMotion('no-preference');
      await cdp.clickButtonWithText('Today');
      await cdp.waitFor(`${h1} === ${JSON.stringify(weekTitle(monday))}`);
      await expectHighlight(monday);

      // A short pan rolls the window off Monday: the highlight follows the
      // days on screen, not the focused day's Monday row.
      await cdp.wheelBurst('.overflow-y-scroll', { count: 4, deltaX: 100 });
      await cdp.waitFor(`${h1} !== ${JSON.stringify(weekTitle(monday))}`);
      await cdp.waitFor(`${panX} === '0px'`);
      await expectHighlight(windowStartOf(await cdp.eval<string>(h1)));

      // A picked day in the week leads it, slid to from the days on screen:
      // the strip starts shifted right (Monday's week where it sat) and eases home.
      await cdp.clickButtonWithText('Today');
      await cdp.waitFor(`${h1} === ${JSON.stringify(weekTitle(monday))}`);
      const thursday = monday.add({ days: 3 });
      const near = await pick(thursday);
      await expectHighlight(thursday);
      expect(near[0]).toBeGreaterThan(0);
      expect(near.length).toBeGreaterThan(2);

      // A far day (next month's 15th) slides in forward too, from two weeks short.
      const shownMonth = Temporal.PlainYearMonth.from(thursday);
      await cdp.eval(`document.querySelector('[aria-label="Next month"]').click()`);
      const far = shownMonth.add({ months: 1 }).toPlainDate({ day: 15 });
      const farOffsets = await pick(far);
      await expectHighlight(far);
      expect(farOffsets[0]).toBeGreaterThan(near[0]!);

      // Backward: the strip starts shifted left and eases home.
      const back = far.with({ day: 5 });
      const backOffsets = await pick(back);
      await expectHighlight(back);
      expect(backOffsets[0]).toBeLessThan(0);

      // Header columns sit over the body's after a slide.
      const maxDrift = await cdp.eval<number>(`(() => {
        const header = document.querySelector('.overflow-hidden > .grid:not(.relative)');
        const body = document.querySelector('[data-testid="week-grid"]');
        let max = 0;
        for (const index of [2, 5, 8]) {
          const headerX = header.children[index].getBoundingClientRect().x;
          const bodyX = body.children[index].getBoundingClientRect().x;
          max = Math.max(max, Math.abs(headerX - bodyX));
        }
        return max;
      })()`);
      expect(maxDrift).toBeLessThanOrEqual(1);

      // Today mid-slide back to today's own Monday: the first day stays, so
      // only the cleared slide says to stop — the strip lands at once.
      await cdp.clickButtonWithText('Today');
      await cdp.waitFor(`${h1} === ${JSON.stringify(weekTitle(monday))}`);
      await pick(thursday);
      const cleared = await cdp.eval<{ after: string; columns: string; during: string }>(
        `(async () => {
          const root = document.querySelector('[data-testid="week-view"]');
          document.querySelector('[data-testid="mini-day-${monday.toString()}"]').click();
          await null;
          const during = root.style.getPropertyValue('--pan-x');
          [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Today').click();
          await null;
          return {
            after: root.style.getPropertyValue('--pan-x'),
            columns: document.querySelector('[data-testid="week-grid"]').style.gridTemplateColumns,
            during,
          };
        })()`,
      );
      expect(cleared.during).not.toBe('0px');
      expect(cleared.after).toBe('0px');
      expect(cleared.columns).toBe('repeat(11, 1fr)');

      // A second pick mid-slide carries on from where the strip is: the
      // first day on screen (fractional, in days) doesn't jump. Only
      // microtasks run between the reads, never an animation frame.
      const friday = thursday.add({ days: 1 });
      const retarget = await cdp.eval<{ after: number; before: number }>(`(async () => {
        const position = () => {
          const header = document.querySelector('[data-date]').parentElement;
          const left = header.parentElement.getBoundingClientRect().x;
          const cell = [...header.children].find((child) => {
            const rect = child.getBoundingClientRect();
            return rect.x <= left && left < rect.x + rect.width;
          });
          const rect = cell.getBoundingClientRect();
          return Date.parse(cell.dataset.date) / 86400000 + (left - rect.x) / rect.width;
        };
        document.querySelector('[data-testid="mini-day-${thursday.toString()}"]').click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const before = position();
        document.querySelector('[data-testid="mini-day-${friday.toString()}"]').click();
        await null;
        return { after: position(), before };
      })()`);
      expect(Math.abs(retarget.after - retarget.before)).toBeLessThan(0.05);
      await cdp.waitFor(`${h1} === ${JSON.stringify(weekTitle(friday))}`);
      await cdp.waitFor(`${columns} === 'repeat(11, 1fr)'`);

      // A press held through a slide's end keeps the extra days drawn (a
      // drag holds the strip column it started in) until it comes up. The
      // hour gutter takes the press without opening anything.
      const gutter = await cdp.eval<{ x: number; y: number }>(`(() => {
        const rect = document.querySelector('[data-testid="week-scroller"]').getBoundingClientRect();
        return { x: Math.round(rect.x + 16), y: Math.round(rect.y + 120) };
      })()`);
      await cdp.clickTestId(`mini-day-${monday.toString()}`);
      await cdp.mouse('mousePressed', gutter.x, gutter.y);
      try {
        await cdp.waitFor(`${h1} === ${JSON.stringify(weekTitle(monday))} && ${panX} === '0px'`);
        expect(await cdp.eval<string>(columns)).not.toBe('repeat(11, 1fr)');
      } finally {
        await cdp.mouse('mouseReleased', gutter.x, gutter.y);
      }
      await cdp.waitFor(`${columns} === 'repeat(11, 1fr)'`);

      // Reduced motion: the picked day leads at once, nothing slides.
      await reducedMotion('reduce');
      const still = await pick(monday.add({ days: 2 }));
      expect(still.every((offset) => offset === 0)).toBe(true);
    } finally {
      await cdp.send('Emulation.setEmulatedMedia', { features: [] });
      await cdp.clickButtonWithText('Today');
      await cdp.clickTestId('view-week');
      await cdp
        .waitFor(`!!document.querySelector('[title^="Standup meeting"]')`)
        .catch(() => undefined);
    }
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
    await cdp.openEditor('[title^="Coffee chat"]');
    await cdp.eval(`(() => {
      const input = document.querySelector('input[placeholder="Title"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Coffee chat (moved)');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!!document.querySelector('[title^="Coffee chat (moved)"]')`);
  });

  it('creates an event by dragging a slot on empty grid space', async () => {
    const { cdp } = app;
    // 19:05 sits in the 19:00 quarter; 1.5 hours down reaches 20:35, which
    // the slot extends to the next quarter.
    const from = await todayGridPoint(19, 5);
    await cdp.drag(from, { x: from.x, y: from.y + 1.5 * HOUR_HEIGHT });
    await cdp.waitFor(`document.body.textContent.includes('New event')`);
    expect(await editorTimes()).toEqual(['19:00', '20:45']);
    await setEditorTitle('Evening run');
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!!document.querySelector('[title^="Evening run"]')`);
    const created = await waitForEvent((event) => event.title === 'Evening run');
    expect(created).toBeDefined();
    expect(created!.endUtc - created!.startUtc).toBe(105 * 60 * 1000);
  });

  it('creates the event once when Save is clicked twice', async () => {
    const { cdp } = app;
    const from = await todayGridPoint(21, 5);
    await cdp.drag(from, { x: from.x, y: from.y + HOUR_HEIGHT });
    await cdp.waitFor(`document.body.textContent.includes('New event')`);
    await setEditorTitle('Saved once');
    // Both clicks land before React re-renders the button disabled.
    await cdp.eval(`(() => {
      const save = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save');
      save.click();
      save.click();
    })()`);
    await cdp.waitFor(`!!document.querySelector('[title^="Saved once"]')`);
    expect(await waitForEvent((event) => event.title === 'Saved once')).toBeDefined();
    // A second create would be written right behind the first.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const saved = (await readEvents(app.userDataDir)).filter(
      (event) => event.title === 'Saved once',
    );
    expect(saved).toHaveLength(1);
  });

  it('draws a slot upwards, keeping the quarter the drag started in', async () => {
    const { cdp } = app;
    const from = await todayGridPoint(23, 5);
    await cdp.drag(from, { x: from.x, y: from.y - HOUR_HEIGHT });
    await cdp.waitFor(`document.body.textContent.includes('New event')`);
    expect(await editorTimes()).toEqual(['22:00', '23:15']);
    await cdp.pressEscape();
    await cdp.waitFor(`!document.body.textContent.includes('New event')`);
  });

  it("keeps the editor's date and times inside the panel", async () => {
    const { cdp } = app;
    const at = await todayGridPoint(2, 5);
    await cdp.click(at.x, at.y);
    await cdp.waitFor(`document.body.textContent.includes('New event')`);
    const fit = await cdp.eval<{ overflow: number; pastEdge: Array<string> }>(`(() => {
      const editor = document.querySelector('[data-testid="editor"]');
      const edge = editor.getBoundingClientRect().right;
      const fields = editor.querySelectorAll('input[type="date"], input[type="time"]');
      return {
        overflow: editor.scrollWidth - editor.clientWidth,
        pastEdge: [...fields]
          .filter((field) => field.getBoundingClientRect().right > edge)
          .map((field) => field.getAttribute('aria-label')),
      };
    })()`);
    expect(fit).toEqual({ overflow: 0, pastEdge: [] });
    await cdp.pressEscape();
    await cdp.waitFor(`!document.body.textContent.includes('New event')`);
  });

  it('cancels drawing a slot with Escape', async () => {
    const { cdp } = app;
    const from = await todayGridPoint(3, 5);
    await cdp.mouse('mousePressed', from.x, from.y);
    for (let step = 1; step <= 5; step += 1) {
      await cdp.mouse('mouseMoved', from.x, from.y + step * 10);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await cdp.waitFor(`!!document.querySelector('[data-testid="slot-selection"]')`);
    await cdp.pressEscape();
    await cdp.waitFor(`!document.querySelector('[data-testid="slot-selection"]')`);
    await cdp.mouse('mouseReleased', from.x, from.y + 50);
    await new Promise((resolve) => setTimeout(resolve, 800));
    // The abandoned release must not fall through to the hour click either.
    expect(await cdp.eval<boolean>(`document.body.textContent.includes('New event')`)).toBe(false);
  });

  it('keeps a click that drifts sideways an hour click', async () => {
    const { cdp } = app;
    // A trackpad click often slides a few pixels; sideways travel must not
    // turn it into a drawn 15-minute slot.
    const at = await todayGridPoint(3, 5);
    await cdp.mouse('mousePressed', at.x, at.y);
    for (let step = 1; step <= 3; step += 1) {
      await cdp.mouse('mouseMoved', at.x + step * 4, at.y);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await cdp.mouse('mouseReleased', at.x + 12, at.y);
    await cdp.waitFor(`document.body.textContent.includes('New event')`);
    expect(await editorTimes()).toEqual(['03:00', '04:00']);
    await cdp.pressEscape();
    await cdp.waitFor(`!document.body.textContent.includes('New event')`);
  });

  it('drops a slot whose column leaves the page mid-drag', async () => {
    const { cdp } = app;
    const from = await todayGridPoint(4, 5);
    await cdp.mouse('mousePressed', from.x, from.y);
    for (let step = 1; step <= 4; step += 1) {
      await cdp.mouse('mouseMoved', from.x, from.y + step * 10);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await cdp.waitFor(`!!document.querySelector('[data-testid="slot-selection"]')`);
    try {
      // Two weeks while the button is still down: even Saturday/Sunday
      // leave the next week's two-day pan buffer, so the column unmounts.
      for (let step = 0; step < 2; step += 1) {
        const before = await cdp.eval<string>(`document.querySelector('h1')?.textContent ?? ''`);
        await cdp.send('Input.dispatchKeyEvent', {
          code: 'ArrowRight',
          key: 'ArrowRight',
          type: 'rawKeyDown',
          windowsVirtualKeyCode: 39,
        });
        await cdp.waitFor(
          `(document.querySelector('h1')?.textContent ?? '') !== ${JSON.stringify(before)}`,
        );
      }
      await cdp.waitFor(`!document.querySelector('[data-testid="slot-selection"]')`);
      await cdp.mouse('mouseReleased', from.x, from.y + 40);
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(await cdp.eval<boolean>(`document.body.textContent.includes('New event')`)).toBe(
        false,
      );
    } finally {
      await cdp.clickButtonWithText('Today');
    }
    // The stale drag is gone: a fresh one draws again.
    const again = await todayGridPoint(4, 5);
    await cdp.mouse('mousePressed', again.x, again.y);
    await cdp.mouse('mouseMoved', again.x, again.y + 30);
    await cdp.waitFor(`!!document.querySelector('[data-testid="slot-selection"]')`);
    await cdp.pressEscape();
    await cdp.mouse('mouseReleased', again.x, again.y + 30);
    await cdp.waitFor(`!document.querySelector('[data-testid="slot-selection"]')`);
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
    // A drag that starts on an event moves it; it never draws a new slot.
    expect(
      await cdp.eval<boolean>(`!!document.querySelector('[data-testid="slot-selection"]')`),
    ).toBe(false);
    expect(await cdp.eval<boolean>(`document.body.textContent.includes('New event')`)).toBe(false);
    // It lands on the row it was dropped on: two hours later on the next
    // day of the grid, wall clock in the device zone the grid draws in. A
    // fixed 26 h is an hour off on the eve of a DST change there.
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const expected = Temporal.Instant.fromEpochMilliseconds(before)
      .toZonedDateTimeISO(zone)
      .toPlainDateTime()
      .add({ days: 1, hours: 2 })
      .toZonedDateTime(zone).epochMilliseconds;
    await cdp.waitFor(`true`);
    const deadline = Date.now() + 10_000;
    let moved = await eventStart('Standup meeting');
    while (moved !== expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      moved = await eventStart('Standup meeting');
    }
    expect(moved).toBe(expected);
  });

  it('lets a press through the now line reach the event under it', async () => {
    const { cdp } = app;
    // The line sits wherever the clock is; pin it across Gym session's
    // resize handle, where a CI run at 15:55 UTC once found it (the locate
    // hit-test landed on the line and the resize test timed out).
    const handle = await cdp.locate('[title^="Gym session"]', { atBottom: true });
    const reachesEvent = await cdp.eval<boolean>(`(() => {
      const line = document.querySelector('[data-testid="now-line"]');
      const column = line.parentElement;
      line.style.top = ${handle.y} - column.getBoundingClientRect().top - 1 + 'px';
      const hit = document.elementFromPoint(${handle.x}, ${handle.y});
      return !!hit && !!hit.closest('[title^="Gym session"]');
    })()`);
    expect(reachesEvent).toBe(true);
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
    await cdp.clickTestId('inspector-edit');
    await cdp.waitFor(
      `document.querySelector('[data-testid="editor-title"]')?.textContent === 'Edit event'`,
    );
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
    await cdp.clickTestId('inspector-edit');
    await cdp.waitFor(
      `document.querySelector('[data-testid="editor-title"]')?.textContent === 'Edit event'`,
    );
    await cdp.clickButtonWithText('All events');
    await setEditorTitle('Daily standup');
    await cdp.clickButtonWithText('Save');

    const master = await waitForEvent(
      (event) => event.id === 'evt-daily' && event.title === 'Daily standup',
    );
    expect(master).toBeDefined();
    expect(master!.startUtc).toBe(dailyStart);
    // Google copies a master's changed title onto every exception, the
    // detached one included — and the app mirrors that at save.
    await cdp.waitFor(`!document.querySelector('[title^="Daily sync (solo)"]')`);
    const override = await waitForEvent(
      (event) => event.recurringEventId === 'evt-daily' && event.title === 'Daily standup',
    );
    expect(override).toBeDefined();
  });

  it('splits the series with this-and-following', async () => {
    const { cdp } = app;
    // The first "Daily standup" block is the detached override (the series
    // rename reached it); the second is the next generated instance.
    await clickNth('[title^="Daily standup"]', 1);
    await cdp.waitFor(`document.body.textContent.includes('This and following')`);
    await cdp.clickTestId('inspector-edit');
    await cdp.waitFor(
      `document.querySelector('[data-testid="editor-title"]')?.textContent === 'Edit event'`,
    );
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
    await cdp.confirmDelete();
    // One occurrence vanishes; the master survives.
    await cdp.waitFor(
      `document.querySelectorAll('[title^="Daily standup v2"]').length === ${countBefore - 1}`,
    );
    const events = await readEvents(app.userDataDir);
    expect(events.some((event) => event.title === 'Daily standup v2')).toBe(true);
  });

  it('toggles calendar visibility from anywhere on its sidebar row, the swatch included', async () => {
    const { cdp } = app;
    const row = '[data-testid="sidebar-calendar-cal-personal"]';
    const pressed = `document.querySelector('${row}')?.getAttribute('aria-pressed')`;
    // The sidebar has no color control: the swatch is the row's checkbox.
    expect(await cdp.eval<boolean>(`!document.querySelector('[aria-label^="Change color"]')`)).toBe(
      true,
    );
    const swatch = await cdp.locate(`${row} > span[aria-hidden]`);
    await cdp.click(swatch.x, swatch.y);
    await cdp.waitFor(`${pressed} === 'false'`);
    await cdp.waitFor(`!document.querySelector('[title^="Gym session"]')`);
    await expect
      .poll(
        async () =>
          (await readCalendars(app.userDataDir)).find((calendar) => calendar.id === 'cal-personal')
            ?.isVisible,
      )
      .toBe(false);

    const name = await cdp.locate(`${row} > span:last-child`);
    await cdp.click(name.x, name.y);
    await cdp.waitFor(`${pressed} === 'true'`);
    await cdp.locate('[title^="Gym session"]');
  });

  it('deletes an event through the editor, after asking', async () => {
    const { cdp } = app;
    await cdp.openEditor('[title^="Coffee chat (moved)"]');
    await cdp.clickButtonWithText('Delete');
    // Asked first, naming what goes; Keep leaves it alone.
    const question = await cdp.waitFor<string>(
      `document.querySelector('[data-testid="move-confirm"]')?.textContent ?? ''`,
    );
    expect(question).toContain('Delete “Coffee chat (moved)”?');
    await cdp.eval(`document.querySelector('[data-testid="move-confirm-no"]').click()`);
    await cdp.waitFor(`!document.querySelector('[data-testid="move-confirm"]')`);
    expect(
      (await readEvents(app.userDataDir)).some((event) => event.title === 'Coffee chat (moved)'),
    ).toBe(true);
    await cdp.clickButtonWithText('Delete');
    await cdp.confirmDelete();
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

  it('creates a weekly event on chosen weekdays', async () => {
    const { cdp } = app;
    const add = await cdp.locate('button[aria-label="New event"]');
    await cdp.click(add.x, add.y);
    await cdp.waitFor(`document.body.textContent.includes('New event')`);
    await setEditorTitle('Board game night');
    await cdp.eval(`(() => {
      const select = document.querySelector('select[aria-label="Repeat"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'weekly');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    // Press Monday and Wednesday, then release whatever else the start
    // date pressed: adding first means the last-day guard never bites.
    for (const day of ['MO', 'WE']) {
      const pressed = await cdp.eval<boolean>(
        `document.querySelector('[data-testid="repeat-weekday-${day}"]')?.getAttribute('aria-pressed') === 'true'`,
      );
      if (!pressed) {
        const button = await cdp.locate(`[data-testid="repeat-weekday-${day}"]`);
        await cdp.click(button.x, button.y);
      }
    }
    for (;;) {
      const extra = await cdp.eval<string | null>(
        `[...document.querySelectorAll('[data-testid^="repeat-weekday-"][aria-pressed="true"]')]
          .map(b => b.dataset.testid).find(id => !id.endsWith('-MO') && !id.endsWith('-WE')) ?? null`,
      );
      if (extra === null) {
        break;
      }
      const button = await cdp.locate(`[data-testid="${extra}"]`);
      await cdp.click(button.x, button.y);
    }
    expect(
      await cdp.eval<string>(
        `document.querySelector('[data-testid="repeat-summary"]')?.textContent ?? ''`,
      ),
    ).toBe('Weekly on Monday, Wednesday');
    await cdp.clickButtonWithText('Save');

    const master = await waitForEvent(
      (event) => event.title === 'Board game night' && event.recurrence !== undefined,
    );
    expect(master?.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO,WE']);
    await cdp.waitFor(`document.querySelectorAll('[title^="Board game night"]').length >= 1`);
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
        event.attendees?.find((attendee) => attendee.email === 'e2e@example.com')
          ?.responseStatus === 'accepted',
    );
    expect(updated).toBeDefined();
    // The organizer's entry stays untouched.
    expect(
      updated!.attendees!.find((attendee) => attendee.email === 'organizer@example.com')!
        .responseStatus,
    ).toBe('accepted');
    await cdp.clickTestId('inspector-close');
  });

  it('creates, renames, and deletes a task through the editor', async () => {
    const { cdp } = app;
    // A free slot opens the editor; the toggle switches it to task mode.
    // The slot is FOUND by hit-testing, not computed from an anchor
    // offset: a fixed offset is secretly date-dependent — the recurring
    // fixture occupies different hours per weekday, and this test's
    // original anchor-minus-4h broke on its first Monday run. Scan the
    // Design-review column (mid-week, never a clipped buffer column) for
    // a point that lands on the bare grid.
    const anchor = await cdp.locate('[title^="Design review"]');
    const free = await cdp.eval<{ x: number; y: number } | null>(`(() => {
      const scroller = document.querySelector('.overflow-y-scroll');
      const bounds = scroller.getBoundingClientRect();
      const x = ${anchor.x};
      for (let y = bounds.top + 12; y < bounds.bottom - 12; y += ${HOUR_HEIGHT} / 4) {
        const hit = document.elementFromPoint(x, y);
        if (hit && !hit.closest('[title]')) {
          return { x, y };
        }
      }
      return null;
    })()`);
    expect(free, 'a free grid cell in the Design-review column').not.toBeNull();
    await cdp.click(free!.x, free!.y);
    await cdp.waitFor(`document.body.textContent.includes('New event')`);
    try {
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
      await cdp.clickTaskChip('[title="Water plants"]');
      await cdp.waitFor(`document.body.textContent.includes('Edit task')`);
      await setEditorTitle('Water the plants');
      await cdp.clickButtonWithText('Save');
      await cdp.waitFor(`!!document.querySelector('[title="Water the plants"]')`);

      // Delete from the same sheet.
      await cdp.clickTaskChip('[title="Water the plants"]');
      await cdp.waitFor(`document.body.textContent.includes('Edit task')`);
      await cdp.clickButtonWithText('Delete');
      await cdp.confirmDelete();
      await cdp.waitFor(`!document.querySelector('[title="Water the plants"]')`);
      await expect
        .poll(async () => {
          const tasks = await readTasks(app.userDataDir);
          return tasks.some((row) => row.title === 'Water the plants');
        })
        .toBe(false);
    } finally {
      // A failure above must not strand an open sheet for later tests.
      await cdp
        .eval(
          `[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Cancel')?.click()`,
        )
        .catch(() => undefined);
    }
  });

  it('moves an overdue task onto today and leaves a completed past task alone', async () => {
    const { cdp } = app;
    await cdp.locate('[data-overdue][title^="Old chore"]');
    // Once in the DOM: on today, not also on its own past day.
    expect(await cdp.eval<number>(`document.querySelectorAll('[title^="Old chore"]').length`)).toBe(
      1,
    );
    const inTodayColumn = await cdp.eval<boolean>(`(() => {
      const chip = document.querySelector('[data-overdue][title^="Old chore"]');
      const cell = document.querySelector('[data-testid="today-header"]');
      const chipRect = chip.getBoundingClientRect();
      const cellRect = cell.getBoundingClientRect();
      return chipRect.left >= cellRect.left - 1 && chipRect.right <= cellRect.right + 1;
    })()`);
    expect(inTodayColumn).toBe(true);
    // A completed task stays on its past day without the overdue marker.
    expect(await cdp.eval<number>(`document.querySelectorAll('[title="Done chore"]').length`)).toBe(
      1,
    );
    expect(await cdp.eval(`!!document.querySelector('[data-overdue][title^="Done chore"]')`)).toBe(
      false,
    );
  });

  it('draws an undated task on today and never gives it a due day by itself', async () => {
    const { cdp } = app;
    await cdp.locate('[data-testid="all-day-task-task-undated"]');
    // On today's column, once, and not marked overdue: it was never due.
    expect(
      await cdp.eval<number>(
        `document.querySelectorAll('[data-testid="all-day-task-task-undated"]').length`,
      ),
    ).toBe(1);
    const placement = await cdp.eval<{ inToday: boolean; overdue: boolean }>(`(() => {
      const chip = document.querySelector('[data-testid="all-day-task-task-undated"]');
      const cell = document.querySelector('[data-testid="today-header"]');
      const chipRect = chip.getBoundingClientRect();
      const cellRect = cell.getBoundingClientRect();
      return {
        inToday: chipRect.left >= cellRect.left - 1 && chipRect.right <= cellRect.right + 1,
        overdue: chip.hasAttribute('data-overdue'),
      };
    })()`);
    expect(placement).toEqual({ inToday: true, overdue: false });

    // The editor says so instead of showing today as its due day, and a
    // rename leaves it undated.
    await cdp.clickTaskChip('[data-testid="all-day-task-task-undated"]');
    await cdp.waitFor(`!!document.querySelector('[data-testid="task-no-due-date"]')`);
    await setEditorTitle('Loose end, renamed');
    await cdp.clickButtonWithText('Save');
    await expect
      .poll(async () => {
        const task = (await readTasks(app.userDataDir)).find((row) => row.id === 'task-undated');
        return { dueDate: task?.dueDate ?? null, title: task?.title };
      })
      .toEqual({ dueDate: null, title: 'Loose end, renamed' });
    await cdp.locate('[title="Loose end, renamed"]');
  });

  it('checks a task off from its all-day chip', async () => {
    const { cdp } = app;
    // The chip renders in the all-day lane with the checkbox leading.
    const checkbox = await cdp.locate('[title="Pay rent"] button');
    // Google tasks never repeat, so no repeat marker.
    expect(
      await cdp.eval<string>(`document.querySelector('[title="Pay rent"]')?.textContent ?? ''`),
    ).not.toContain('\u21bb');
    await cdp.click(checkbox.x, checkbox.y);

    await cdp.waitFor(`document.querySelector('[title="Pay rent"] [data-done]') !== null`);
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

  it('recolors a calendar from Settings › Accounts', async () => {
    const { cdp } = app;
    const settings = await app.openSettings('accounts');
    try {
      const point = await settings.locate('[aria-label="Change color: Personal"]');
      await settings.click(point.x, point.y);
      await settings.waitFor(`!!document.querySelector('[aria-label="Set color #16a765"]')`);
      const swatch = await settings.locate('[aria-label="Set color #16a765"]');
      await settings.click(swatch.x, swatch.y);
      await settings.waitFor(`!document.querySelector('[aria-label="Close color picker"]')`);
    } finally {
      await app.closeSettings();
    }

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
    // The calendar window's chip repaints from its own calendars atom.
    await cdp.waitFor(
      `(() => { const el = document.querySelector('[title^="Gym session"]'); return el && el.dataset.color === '#16a765'; })()`,
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
    // Discard lives in a row's expanded panel. The mutation is
    // fire-and-forget in the UI; re-open and re-click if a transient
    // failure swallowed the first attempt.
    const deadline = Date.now() + 12_000;
    let after = count;
    let lastClickAt = 0;
    while (after >= count && Date.now() < deadline) {
      if (Date.now() - lastClickAt > 3000) {
        const first = await cdp.locate('[data-testid^="pending-op-"][aria-expanded="false"]');
        await cdp.click(first.x, first.y);
        await cdp.clickButtonWithText('Discard change');
        lastClickAt = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      after = await readPendingOpsCount(app.userDataDir);
    }
    expect(after).toBeLessThan(count);
  });

  it('controls screen-sharing privacy from the settings window', async () => {
    const cdp = await app.openSettings('sharing');

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
    await cdp.waitFor(
      `[...document.querySelectorAll('[role="radio"]')].some(b => b.textContent === 'Hidden' && b.getAttribute('aria-checked') === 'true')`,
    );
    await app.closeSettings();
  });

  it('shades the weekend days, and Settings › Calendar picks them or turns the shade off', async () => {
    const { cdp } = app;
    // The weekdays of the shaded columns (or month cells) in view, as
    // weekday codes: the week strip always holds every weekday, so the
    // answer is the same on any date.
    const shadedIn = (root: string) =>
      cdp.eval<Array<string>>(
        `[...new Set([...document.querySelectorAll('[data-testid="${root}"] [data-weekend]')].map((cell) => ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(cell.dataset.day + 'T12:00:00').getDay()]))].sort()`,
      );
    const stored = () => readDeviceSetting(app.userDataDir, 'viewPreferences');
    await cdp.waitFor(`!!document.querySelector('[data-testid="week-grid"] [data-weekend]')`);
    expect(await shadedIn('week-grid')).toEqual(['SA', 'SU']);
    expect(await shadedIn('all-day-lane')).toEqual(['SA', 'SU']);

    const settings = await app.openSettings('calendar');
    const pressed = (day: string) =>
      settings.eval<string | null>(
        `document.querySelector('[data-testid="weekend-day-${day}"]')?.getAttribute('aria-pressed') ?? null`,
      );
    const toggleDay = async (day: string, to: boolean) => {
      await settings.eval(`document.querySelector('[data-testid="weekend-day-${day}"]')?.click()`);
      await settings.waitFor(
        `document.querySelector('[data-testid="weekend-day-${day}"]')?.getAttribute('aria-pressed') === ${JSON.stringify(String(to))}`,
      );
    };
    const shadeWeekends = () =>
      settings.eval(`document.querySelector('input[aria-label="Shade weekends"]')?.click()`);
    try {
      // The pane draws its days once this window's own read of the preferences lands.
      await settings.waitFor(
        `document.querySelector('[data-testid="weekend-day-SA"]')?.getAttribute('aria-pressed') === 'true'`,
      );
      expect(await pressed('FR')).toBe('false');
      // Two clicks straight after each other, each its own task as a
      // person's are: the second builds on the first, so Friday stays. The
      // spec cannot hold a save's read-back, so it shows the chain, not the
      // race with a slow read-back (useSettingsEditor's tests cover that).
      await settings.eval(`document.querySelector('[data-testid="weekend-day-FR"]').click()`);
      await settings.eval(`document.querySelector('[data-testid="weekend-day-SU"]').click()`);
      await expect.poll(stored, { timeout: 10_000 }).toMatchObject({ weekendDays: ['FR', 'SA'] });
      expect(await pressed('FR')).toBe('true');
      expect(await pressed('SU')).toBe('false');
      // The calendar window follows a change made in the settings window.
      await expect.poll(() => shadedIn('week-grid'), { timeout: 10_000 }).toEqual(['FR', 'SA']);
      expect(await shadedIn('all-day-lane')).toEqual(['FR', 'SA']);
      await cdp.clickTestId('view-month');
      try {
        await expect.poll(() => shadedIn('month-grid'), { timeout: 10_000 }).toEqual(['FR', 'SA']);
      } finally {
        await cdp.clickTestId('view-week');
      }

      // Off: nothing is shaded, and the days stay as picked.
      await shadeWeekends();
      await settings.waitFor(
        `document.querySelector('[data-testid="weekend-day-FR"]')?.disabled === true`,
      );
      await expect.poll(() => shadedIn('week-grid'), { timeout: 10_000 }).toEqual([]);
      expect(await stored()).toMatchObject({ weekendDays: ['FR', 'SA'], weekendShading: false });
    } finally {
      // Back to the defaults for the remaining flows.
      if (
        await settings.eval<boolean>(
          `document.querySelector('input[aria-label="Shade weekends"]')?.checked === false`,
        )
      ) {
        await shadeWeekends();
        await settings.waitFor(
          `document.querySelector('[data-testid="weekend-day-FR"]')?.disabled === false`,
        );
      }
      if ((await pressed('FR')) === 'true') {
        await toggleDay('FR', false);
      }
      if ((await pressed('SU')) === 'false') {
        await toggleDay('SU', true);
      }
      await app.closeSettings();
    }
    await expect.poll(() => shadedIn('week-grid'), { timeout: 10_000 }).toEqual(['SA', 'SU']);
  });

  it('says so while a screen capture leaves the window out, and pauses privacy from there', async () => {
    const { cdp } = app;
    const phase = () =>
      cdp.eval<string>(`document.querySelector('[data-testid="capture-hint"]').dataset.phase`);
    const waitForPhase = (expected: string, timeoutMs?: number) =>
      cdp.waitFor(
        `document.querySelector('[data-testid="capture-hint"]')?.dataset.phase === ${JSON.stringify(expected)}`,
        timeoutMs,
      );

    // Hidden (the default): the hint shows during a capture and lingers
    // after it — ⌘⇧3 is over before anything can be drawn — then goes.
    await waitForPhase('off');
    app.setCapturing(true);
    await waitForPhase('capturing');
    app.setCapturing(false);
    await waitForPhase('after');
    await waitForPhase('off', 10_000);

    // Its button makes the window visible for 10 minutes.
    app.setCapturing(true);
    await waitForPhase('capturing');
    app.setCapturing(false);
    await waitForPhase('after');
    await cdp.clickTestId('capture-hint-show');
    await waitForPhase('off');
    const state = await cdp.eval<{ mode: string; visibleUntil?: number }>(
      `window.calendarBridge.privacyGet()`,
    );
    expect(state.mode).toBe('hidden');
    expect(state.visibleUntil).toBeGreaterThan(Date.now());

    // A capture that includes the window says nothing.
    app.setCapturing(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await phase()).toBe('off');
    app.setCapturing(false);

    // Back to the default for the remaining flows.
    await cdp.eval(`window.calendarBridge.privacySet('hidden')`);
  });

  it('keeps the capture hint true in every window, the one opened mid-capture included', async () => {
    const { cdp } = app;
    // Settings opened while a capture runs is left out of it too, and says so.
    app.setCapturing(true);
    await cdp.waitFor(captureHintIs('capturing'));
    const settings = await app.openSettings('sharing');
    await settings.waitFor(captureHintIs('capturing'));

    // Showing the windows from one hint clears the other at once: it must
    // not linger on "hidden" while the capture now includes it.
    await cdp.clickTestId('capture-hint-show');
    await cdp.waitFor(captureHintIs('off'));
    await settings.waitFor(captureHintIs('off'), 2000);
    app.setCapturing(false);

    // Back to the default for the remaining flows.
    await cdp.eval(`window.calendarBridge.privacySet('hidden')`);
    await app.closeSettings();
  });

  it('opens settings as its own window: one at most, on the pane asked for', async () => {
    const { cdp } = app;
    const title = `document.querySelector('[data-testid="settings-title"]')?.textContent`;
    expect(await app.windowCount()).toBe(1);

    const settings = await app.openSettings('agents');
    await settings.waitFor(`${title} === 'Agents'`);
    expect(await settings.eval<string>('document.title')).toBe('Agents');
    expect(await app.windowCount()).toBe(2);
    // Mirrors and Agents are listed last, under "Experimental", and each
    // says so at its top; the other panes do not.
    expect(
      await settings.eval<Array<string>>(
        `[...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)`,
      ),
    ).toEqual([
      'Accounts',
      'Calendar',
      'Notifications',
      'Time Zones',
      'AI Model',
      'Screen Sharing',
      'Settings File',
      'Getting Started',
      'Advanced',
      'Mirrors',
      'Agents',
    ]);
    expect(
      await settings.eval<string | null>(
        `document.querySelector('[data-testid="settings-experimental-heading"]')?.nextElementSibling?.textContent ?? null`,
      ),
    ).toBe('MirrorsAgents');
    expect(
      await settings.eval<Array<string>>(
        `[...document.querySelectorAll('[data-testid="settings-experimental-note"]')].map((note) => note.closest('[role="tabpanel"]').id)`,
      ),
    ).toEqual(['settings-pane-mirrors', 'settings-pane-agents']);
    // The calendar is no longer covered by anything.
    expect(await cdp.eval(`!!document.querySelector('[role="dialog"]')`)).toBe(false);

    // The sidebar button moves the open window to Accounts: no second
    // window, and no reload (the page's own state survives).
    await settings.eval(`void (window.__settingsMarker = 'kept')`);
    await cdp.clickButtonWithText('Manage accounts…');
    await settings.waitFor(`${title} === 'Accounts'`);
    await settings.waitFor(
      `document.querySelector('[data-testid="settings-pane-accounts"]')?.hidden === false && document.body.textContent.includes('Add Google Account')`,
    );
    expect(await settings.eval<string>('window.__settingsMarker')).toBe('kept');
    expect(await app.windowCount()).toBe(2);

    // A toolbar tab switches the pane and the window's title with it.
    const tab = await settings.locate('[data-testid="settings-tab-notifications"]');
    await settings.click(tab.x, tab.y);
    await settings.waitFor(`${title} === 'Notifications'`);
    expect(await settings.eval<string>('document.title')).toBe('Notifications');
    expect(
      await settings.eval(
        `document.querySelector('[data-testid="settings-pane-accounts"]')?.hidden === true`,
      ),
    ).toBe(true);

    // The sidebar's search narrows the panes by label and keyword; the
    // pane in view stays even when its tab is filtered out.
    await settings.type('[data-testid="settings-search"]', 'token');
    await settings.waitFor(
      `document.querySelectorAll('[role="tab"]').length === 1 && !!document.querySelector('[data-testid="settings-tab-agents"]')`,
    );
    expect(await settings.eval<string>('document.title')).toBe('Notifications');
    await settings.eval(`(() => {
      const input = document.querySelector('[data-testid="settings-search"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await settings.waitFor(`document.querySelectorAll('[role="tab"]').length === 11`);

    // The main process reads the pane from the window's URL, so it must
    // have followed the tab click: asking for Accounts again moves back.
    await cdp.clickButtonWithText('Manage accounts…');
    await settings.waitFor(`${title} === 'Accounts'`);
    expect(await settings.eval<string>('window.__settingsMarker')).toBe('kept');
    await settings.click(tab.x, tab.y);
    await settings.waitFor(`${title} === 'Notifications'`);

    // Closed and reopened without naming a pane, as the menu item does:
    // back on the pane viewed last.
    await app.closeSettings();
    await expect.poll(() => app.windowCount(), { timeout: 10_000 }).toBe(1);
    await cdp.eval(`window.calendarBridge.openSettings()`);
    const reopened = await app.settingsPage();
    await reopened.waitFor(`${title} === 'Notifications'`);
    await app.closeSettings();
    // The calendar window was never touched.
    expect(await cdp.eval(`document.body.textContent.includes('Today')`)).toBe(true);
  });
  it('keeps a pane asked for while the settings window is still opening', async () => {
    const { cdp } = app;
    // A second request at several points of the window's start-up: before
    // its first navigation has committed (the main process has no URL to
    // compare yet), while the page loads, and around the page's first
    // render. Neither request may fail, and the later one wins.
    for (const gapMs of [0, 30, 60, 90, 150]) {
      const outcomes = await cdp.eval<Array<string>>(`(async () => {
        const first = window.calendarBridge.openSettings('timezones');
        await new Promise((resolve) => setTimeout(resolve, ${gapMs}));
        const second = window.calendarBridge.openSettings('accounts');
        return (await Promise.allSettled([first, second])).map((result) => result.status);
      })()`);
      expect(outcomes, `gap ${gapMs} ms`).toEqual(['fulfilled', 'fulfilled']);
      const settings = await app.settingsPage();
      await settings.waitFor(
        `document.querySelector('[data-testid="settings-title"]')?.textContent === 'Accounts'`,
      );
      expect(await app.windowCount()).toBe(2);
      await app.closeSettings();
      await expect.poll(() => app.windowCount(), { timeout: 10_000 }).toBe(1);
    }
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

  it('edits notes through the editor and reads them back in the inspector', async () => {
    const { cdp } = app;
    await cdp.openEditor('[title^="Gym session"]');
    await cdp.eval(`(() => {
      const input = document.querySelector('[data-testid="editor-notes"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, 'Bring the resistance bands');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.clickButtonWithText('Save');
    const updated = await waitForEvent(
      (event) =>
        event.title === 'Gym session' && event.description === 'Bring the resistance bands',
    );
    expect(updated).toBeDefined();
    // The inspector shows the notes read-first; Escape leaves it.
    await cdp.openInspector('[title^="Gym session"]');
    await cdp.waitFor(
      `document.querySelector('[data-testid="inspector-notes"]')?.textContent === 'Bring the resistance bands'`,
    );
    await cdp.pressEscape();
    await cdp.waitFor(`!document.querySelector('[data-testid="inspector"]')`);
  });

  it('converts from the inspector with the event carried into the task form', async () => {
    const { cdp } = app;
    await cdp.openInspector('[title^="Gym session"]');
    await cdp.clickTestId('inspector-convert');
    await cdp.waitFor(
      `document.querySelector('[data-testid="editor-title"]')?.textContent === 'Convert to task'`,
    );
    expect(
      await cdp.eval<string>(`document.querySelector('input[placeholder="Title"]').value`),
    ).toBe('Gym session');
    expect(
      await cdp.eval<string>(`document.querySelector('textarea[placeholder="Add notes"]').value`),
    ).toBe('Bring the resistance bands');
    await cdp.clickButtonWithText('Cancel');
    await cdp.waitFor(`!document.querySelector('[data-testid="editor"]')`);
  });

  it('finds a free slot for a new event and moves it there', async () => {
    const { cdp } = app;
    const add = await cdp.locate('button[aria-label="New event"]');
    await cdp.click(add.x, add.y);
    await cdp.waitFor(`document.body.textContent.includes('New event')`);
    await cdp.clickTestId('find-time');
    await cdp.waitFor(`!!document.querySelector('[data-testid="find-time-fields"]')`);
    // Next week, mornings: a window with free time whatever today is.
    await cdp.clickTestId('find-time-window-nextWeek');
    await cdp.clickTestId('find-time-bounds-mornings');
    await cdp.clickTestId('find-time-duration-90');
    await cdp.clickTestId('find-time-search');
    await cdp.waitFor(`!!document.querySelector('[data-testid="find-time-slot-0"]')`);
    await cdp.clickTestId('find-time-slot-0');
    // The pick moves the draft and closes the finder.
    await cdp.waitFor(`!document.querySelector('[data-testid="find-time-fields"]')`);
    const fields = await cdp.eval<{ date: string; end: string; start: string }>(`({
      date: document.querySelector('[data-testid="editor"] input[type="date"]').value,
      end: document.querySelectorAll('[data-testid="editor"] input[type="time"]')[1].value,
      start: document.querySelectorAll('[data-testid="editor"] input[type="time"]')[0].value,
    })`);
    // Next Monday to Sunday, in the app's local days.
    const isoWeekday = ((new Date().getDay() + 6) % 7) + 1;
    const toSunday = 7 - isoWeekday;
    const nextMonday = localIsoDaysAgo(-(toSunday + 1));
    const nextSunday = localIsoDaysAgo(-(toSunday + 7));
    expect(fields.date >= nextMonday && fields.date <= nextSunday).toBe(true);
    expect(fields.start >= '08:00' && fields.start < '12:00').toBe(true);
    expect(minuteOfDay(fields.end) - minuteOfDay(fields.start)).toBe(90);
    await cdp.pressEscape();
    await cdp.waitFor(`!document.querySelector('[data-testid="editor"]')`);
  });

  it('reseeds the editor when another slot is clicked while it is open', async () => {
    const { cdp } = app;
    // Two empty slots in today's column, which is on screen whatever the
    // weekday. Standup, which this test used to aim from, is in tomorrow's
    // column after the drag test: on a Sunday that is off the week, and
    // from Thursday on the editor the first click opens covered it.
    // Each slot is found right before its click, once today's column sits
    // inside the grid: the editor narrows the grid, and a window at the
    // back only lays the narrower columns out in a drawn frame.
    const todayInGrid = `(() => {
      const view = document.querySelector('[data-testid="week-grid"]').parentElement.getBoundingClientRect();
      const header = document.querySelector('[data-testid="today-header"]').getBoundingClientRect();
      const center = header.x + header.width / 2;
      return center > view.x && center < view.x + view.width;
    })()`;
    const emptySlot = async (fromHour: number) => {
      await cdp.waitForRendered<boolean>(todayInGrid);
      const slot = await cdp.eval<{ hour: number; x: number; y: number } | null>(`(() => {
        const scroller = document.querySelector('[data-testid="week-scroller"]');
        const header = document.querySelector('[data-testid="today-header"]').getBoundingClientRect();
        const x = Math.round(header.x + header.width / 2);
        for (let hour = ${fromHour}; hour < 22; hour += 1) {
          scroller.scrollTop = hour * ${HOUR_HEIGHT} - 120;
          const y = Math.round(
            scroller.getBoundingClientRect().top + hour * ${HOUR_HEIGHT} - scroller.scrollTop + 10,
          );
          const hit = document.elementFromPoint(x, y);
          if (hit?.closest('[data-testid="week-grid"]') && !hit.closest('[title]')) {
            return { hour, x, y };
          }
        }
        return null;
      })()`);
      if (!slot) {
        throw new Error(`no empty slot in today's column from ${String(fromHour)}:00`);
      }
      return slot;
    };
    const START = `document.querySelector('[data-testid="editor"] input[type="time"]')?.value`;
    try {
      const first = await emptySlot(8);
      await cdp.click(first.x, first.y);
      await cdp.waitFor(
        `document.querySelector('[data-testid="editor-title"]')?.textContent === 'New event'`,
      );
      const firstStart = await cdp.eval<string>(START);
      const second = await emptySlot(first.hour + 1);
      await cdp.click(second.x, second.y);
      await cdp.waitFor(`${START} !== ${JSON.stringify(firstStart)}`);
    } finally {
      // Closed even when an attempt fails, so the retry and the next tests
      // start without an editor in the panel.
      await cdp.pressEscape();
      await cdp.waitFor(`!document.querySelector('[data-testid="editor"]')`);
    }
  });

  it('adds an undated task through New › Task › No due date', async () => {
    const { cdp } = app;
    await cdp.showRail();
    const add = await cdp.locate('button[aria-label="New event"]');
    await cdp.click(add.x, add.y);
    await cdp.waitFor(`document.body.textContent.includes('New event')`);
    await cdp.clickButtonWithText('Task');
    await cdp.waitFor(`document.body.textContent.includes('New task')`);
    await cdp.clickTestId('task-remove-due-date');
    await cdp.waitFor(`!!document.querySelector('[data-testid="task-no-due-date"]')`);
    await cdp.eval(`(() => {
      const input = document.querySelector('input[placeholder="Title"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Sharpen the pencils');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.clickButtonWithText('Save');
    await expect
      .poll(async () => {
        const task = (await readTasks(app.userDataDir)).find(
          (row) => row.title === 'Sharpen the pencils',
        );
        return task && { dueDate: task.dueDate ?? null, title: task.title };
      })
      .toEqual({ dueDate: null, title: 'Sharpen the pencils' });
    // It lands in the inbox's "No date" group right away.
    await cdp.waitFor(
      `document.querySelector('[data-testid="task-inbox"]')?.textContent.includes('Sharpen the pencils')`,
    );
  });

  it('drags a task row from the panel onto the all-day lane and dates it', async () => {
    const { cdp } = app;
    await cdp.showRail();
    const row = await cdp.locate('[data-testid="panel-task-task-undated"]');
    const column = await cdp.locate('[data-testid="today-header"]');
    const lane = await cdp.locate('[data-testid="all-day-lane"]');
    await cdp.drag(row, { x: column.x, y: lane.y });
    await expect
      .poll(
        async () =>
          (await readTasks(app.userDataDir)).find((task) => task.id === 'task-undated')?.dueDate,
      )
      .toBe(todayLocalIso());
    // The release was a drop, not a click: no editor opened.
    expect(await cdp.eval<boolean>(`!!document.querySelector('[data-testid="editor"]')`)).toBe(
      false,
    );
  });

  it('takes a due day away again: the task goes back to "No due date"', async () => {
    const { cdp } = app;
    // Opened from its rail row, which keeps its width: with the rail open
    // at CI's 1024 px a lane chip is narrower than the offset past its
    // checkbox, and a click there lands beside it.
    const openFromRail = async () => {
      await cdp.showRail();
      await cdp.clickTestId('panel-task-task-undated');
    };
    // Dated today by the drag above.
    await openFromRail();
    await cdp.waitFor(`!!document.querySelector('[data-testid="task-remove-due-date"]')`);
    await cdp.clickTestId('task-remove-due-date');
    await cdp.waitFor(`!!document.querySelector('[data-testid="task-no-due-date"]')`);
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!document.querySelector('[data-testid="editor"]')`);
    await expect
      .poll(
        async () =>
          (await readTasks(app.userDataDir)).find((task) => task.id === 'task-undated')?.dueDate ??
          null,
      )
      .toBeNull();
    // The queued edit takes the day away on Google (`due: null`), the
    // earlier rename riding along.
    const edit = (await readPendingOps(app.userDataDir)).find(
      (op) => op.kind === 'updateTask' && op.eventId === 'task-undated',
    );
    expect(edit && { taskDue: edit.taskDue, taskTitle: edit.taskTitle }).toEqual({
      taskDue: null,
      taskTitle: 'Loose end, renamed',
    });
    // Reopened, it says so.
    await openFromRail();
    await cdp.waitFor(`!!document.querySelector('[data-testid="task-no-due-date"]')`);
    await cdp.clickButtonWithText('Cancel');
    await cdp.waitFor(`!document.querySelector('[data-testid="editor"]')`);
  });

  it('leaves a panel row alone when it is released inside the panel', async () => {
    const { cdp } = app;
    const pencils = (await readTasks(app.userDataDir)).find(
      (task) => task.title === 'Sharpen the pencils',
    )!;
    await cdp.showRail();
    const row = await cdp.locate(`[data-testid="panel-task-${pencils.id}"]`);
    const lane = await cdp.locate('[data-testid="all-day-lane"]');
    // Down to the lane's height, but still over the panel: no column.
    await cdp.drag(row, { x: row.x, y: lane.y });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      (await readTasks(app.userDataDir)).find((task) => task.id === pencils.id)?.dueDate ?? null,
    ).toBeNull();
    expect(await cdp.eval<boolean>(`!!document.querySelector('[data-testid="editor"]')`)).toBe(
      false,
    );
  });
});

describe('Google task chips drag along the lane but never into the grid', () => {
  let taskApp: App;

  beforeAll(async () => {
    taskApp = await launchApp(seed);
  }, 60_000);

  afterEach(async (context) => {
    if (context.task.result?.state === 'fail') {
      await taskApp?.dump(context.task.name);
    }
  });

  afterAll(async () => {
    await taskApp?.stop();
  });

  const rent = async () =>
    (await readTasks(taskApp.userDataDir)).find((task) => task.id === 'task-rent');

  it('refuses a grid drop with an explanation and changes nothing', async () => {
    const { cdp } = taskApp;
    const from = await cdp.locate('[data-testid="all-day-task-task-rent"]');
    const y = await cdp.eval<number>(`(() => {
      const scroller = document.querySelector('.overflow-y-scroll');
      return scroller.getBoundingClientRect().top + 10 * ${HOUR_HEIGHT} - scroller.scrollTop;
    })()`);
    await cdp.drag(from, { x: from.x, y });
    await cdp.waitFor(`document.body.textContent.includes('Google Tasks are date-only')`);
    expect(await rent()).toMatchObject({ dueDate: todayLocalIso(), status: 'needsAction' });
    expect(
      (await readPendingOps(taskApp.userDataDir)).some(
        (op) => op.kind === 'updateTask' && op.eventId === 'task-rent',
      ),
    ).toBe(false);
    expect(await cdp.eval(`document.body.textContent.includes('Edit task')`)).toBe(false);
    await cdp.locate('[data-testid="all-day-task-task-rent"]');
  });

  it('moves to another day along the lane through the op queue', async () => {
    const { cdp } = taskApp;
    const dayWidth = await cdp.eval<number>(
      `document.querySelector('.relative.grid').getBoundingClientRect().width / document.querySelector('.relative.grid').children.length`,
    );
    const from = await cdp.locate('[data-testid="all-day-task-task-rent"]');
    await cdp.drag(from, { x: from.x + dayWidth, y: from.y });
    await expect.poll(rent).toMatchObject({ dueDate: localIsoDaysAgo(-1) });
    await expect
      .poll(async () =>
        (await readPendingOps(taskApp.userDataDir)).some(
          (op) => op.kind === 'updateTask' && op.eventId === 'task-rent',
        ),
      )
      .toBe(true);
  });
});

describe('the color picker in a long Settings › Accounts list', () => {
  let listApp: App;

  beforeAll(async () => {
    listApp = await launchApp({
      accounts: [account],
      calendars: Array.from({ length: 14 }, (_, index) =>
        calendar(`cal-${String(index)}`, `Calendar ${String(index).padStart(2, '0')}`, '#4986e7'),
      ),
      events: [],
    });
  }, 60_000);

  afterEach(async (context) => {
    if (context.task.result?.state === 'fail') {
      await listApp?.dump(context.task.name);
    }
  });

  afterAll(async () => {
    await listApp?.stop();
  });

  it('opens above a low row inside the fixed window, keeps Tab inside, recolors, and closes with its pane', async () => {
    const settings = await listApp.openSettings('accounts');
    try {
      await settings.waitFor(
        `document.querySelectorAll('[aria-label^="Change color"]').length === 14`,
      );
      // The lowest well that shows unscrolled: the 560 px window has no
      // room for the picker under it.
      const well = await settings.eval<{
        label: string;
        right: number;
        top: number;
        x: number;
        y: number;
      }>(`(() => {
        const wells = [...document.querySelectorAll('[aria-label^="Change color"]')]
          .filter((el) => el.getBoundingClientRect().bottom <= window.innerHeight);
        const el = wells.at(-1);
        const r = el.getBoundingClientRect();
        return { label: el.getAttribute('aria-label'), right: r.right, top: r.top, x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      expect(well.top).toBeGreaterThan(400);
      await settings.click(well.x, well.y);
      const panel = `document.querySelector('[role="dialog"][aria-label^="Color of"]')`;
      await settings.waitFor(`!!${panel}`);
      const rect = await settings.eval<{
        bottom: number;
        left: number;
        right: number;
        top: number;
        width: number;
      }>(
        `(() => { const r = ${panel}.getBoundingClientRect(); return { bottom: r.bottom, left: r.left, right: r.right, top: r.top, width: r.width }; })()`,
      );
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.bottom).toBeLessThanOrEqual(await settings.eval<number>('window.innerHeight'));
      expect(rect.bottom).toBeLessThanOrEqual(well.top);
      // Hung from the well's right edge at the palette's full width (six
      // 20 px swatches, not squeezed to what is left of the window).
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(Math.abs(rect.right - well.right)).toBeLessThanOrEqual(1);
      expect(rect.width).toBeGreaterThan(6 * 20);

      // Focus opens on the calendar's current color. Tab and Shift+Tab go
      // round the 24 swatches and the Custom field, in order, past both
      // ends — never to the pane tabs behind the backdrop.
      const focused = `(${panel}.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : 'outside')`;
      const stops = await settings.eval<Array<string>>(
        `[...${panel}.querySelectorAll('button, input')].map((stop) => stop.getAttribute('aria-label'))`,
      );
      expect(stops).toHaveLength(25);
      let at = stops.indexOf('Set color #4986e7');
      expect(await settings.eval<string>(focused)).toBe(stops[at]);
      for (const step of [1, -1]) {
        for (let press = 0; press < stops.length + 2; press += 1) {
          await settings.pressTab(step === -1);
          at = (at + step + stops.length) % stops.length;
          expect(await settings.eval<string>(focused)).toBe(stops[at]);
        }
      }

      const swatch = await settings.locate('[aria-label="Set color #16a765"]');
      await settings.click(swatch.x, swatch.y);
      await settings.waitFor(`!${panel}`);
      // Focus is back on the well it opened from.
      expect(
        await settings.eval<string | null>(`document.activeElement?.getAttribute('aria-label')`),
      ).toBe(well.label);
      const summary = well.label.replace('Change color: ', '');
      await expect
        .poll(
          async () =>
            (await readCalendars(listApp.userDataDir)).find(
              (calendar) => calendar.summary === summary,
            )?.colorHex,
        )
        .toBe('#16a765');

      // Another pane only hides Accounts: a picker left open there would
      // take the next Escape, so the pane switch closes it.
      await settings.click(well.x, well.y);
      await settings.waitFor(`!!${panel}`);
      await settings.eval(`location.replace('#settings/notifications')`);
      await settings.waitFor(`!${panel}`);
      await settings.waitFor(`!document.querySelector('[aria-label="Close color picker"]')`);
    } finally {
      await listApp.closeSettings();
    }
  });
});

describe('an event in a read-only calendar', () => {
  let viewerApp: App;

  beforeAll(async () => {
    viewerApp = await launchApp({
      ...seed,
      calendars: [
        ...seed.calendars,
        new CalendarInfo({ ...calendar('cal-shared', 'Team', '#a855f7'), accessRole: 'reader' }),
      ],
      events: [timedEvent('evt-shared', 'cal-shared', 'Their review', todayAt(11), todayAt(12))],
    });
  }, 60_000);

  afterEach(async (context) => {
    if (context.task.result?.state === 'fail') {
      await viewerApp?.dump(context.task.name);
    }
  });

  afterAll(async () => {
    await viewerApp?.stop();
  });

  const shared = async () =>
    (await readEvents(viewerApp.userDataDir)).find((event) => event.id === 'evt-shared');

  it('neither moves nor resizes, and opens as a viewer', async () => {
    const { cdp } = viewerApp;
    const before = await shared();
    const from = await cdp.locate('[title^="Their review"]');
    await cdp.drag(from, { x: from.x, y: from.y + 2 * HOUR_HEIGHT });
    const handle = await cdp.locate('[title^="Their review"]', { atBottom: true });
    await cdp.drag(handle, { x: handle.x, y: handle.y + HOUR_HEIGHT });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await shared()).toMatchObject({
      endUtc: before!.endUtc,
      startUtc: before!.startUtc,
      syncStatus: 'synced',
    });
    expect(await readPendingOps(viewerApp.userDataDir)).toEqual([]);
    // The release did not fall through to the grid as a slot click.
    expect(await cdp.eval(`!!document.querySelector('[data-testid="editor"]')`)).toBe(false);
    // Still a click target: it opens the viewer.
    const block = await cdp.locate('[title^="Their review"]');
    await cdp.click(block.x, block.y);
    await cdp.waitFor(`!!document.querySelector('[data-testid="event-read-only"]')`);
  });
});

/** A date's UTC midnight: where an all-day event's instants sit. */
const utcMidnight = (date: string): number => Date.parse(`${date}T00:00:00Z`);

describe('an event that ends on a later day', () => {
  // Built in the device's zone, which the editor's fields are wall clock in.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = Temporal.Now.plainDateISO(zone);
  // Days count from this week's Monday, not today: a span that starts
  // on a Sunday runs on into next week's buffer columns, where the
  // harness cannot click its block.
  const base = today.subtract({ days: today.dayOfWeek - 1 });
  const localAt = (date: Temporal.PlainDate, hour: number): number =>
    date.toZonedDateTime({ plainTime: new Temporal.PlainTime(hour), timeZone: zone })
      .epochMilliseconds;
  const day = (offset: number): string => base.add({ days: offset }).toString();
  let spanApp: App;

  beforeAll(async () => {
    spanApp = await launchApp({
      ...seed,
      events: [
        // Three days from today: Google's end is the day after the last.
        timedEvent(
          'evt-conference',
          'cal-work',
          'Conference',
          utcMidnight(day(0)),
          utcMidnight(day(3)),
          {
            endDate: day(3),
            isAllDay: true,
            startDate: day(0),
            startTimeZone: undefined,
          },
        ),
        // Thirty seconds past the minute, as another client may write it: the
        // form shows minutes, so only leaving untouched times alone keeps them.
        timedEvent(
          'evt-night',
          'cal-work',
          'Night shift',
          localAt(base, 22) + 30_000,
          localAt(base.add({ days: 1 }), 1),
          {
            startTimeZone: zone,
          },
        ),
      ],
    });
  }, 60_000);

  afterEach(async (context) => {
    if (context.task.result?.state === 'fail') {
      await spanApp?.dump(context.task.name);
    }
  });

  afterAll(async () => {
    await spanApp?.stop();
  });

  const stored = async (id: string) =>
    (await readEvents(spanApp.userDataDir)).find((event) => event.id === id);
  const fieldValue = (label: string) =>
    spanApp.cdp.eval<string>(
      `document.querySelector('[data-testid="editor"] input[aria-label="${label}"]')?.value ?? ''`,
    );
  const setField = (label: string, value: string) =>
    spanApp.cdp.eval(`(() => {
      const input = document.querySelector('[data-testid="editor"] input[aria-label="${label}"]')
        ?? document.querySelector('input[placeholder="${label}"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);

  it('keeps a multi-day all-day event whole when only its title changes', async () => {
    const { cdp } = spanApp;
    await cdp.openEditor('[title^="Conference"]');
    expect({ end: await fieldValue('End date'), start: await fieldValue('Date') }).toEqual({
      end: day(2),
      start: day(0),
    });
    await setField('Title', 'Conference (renamed)');
    await cdp.clickButtonWithText('Save');
    await expect
      .poll(async () => {
        const event = await stored('evt-conference');
        return { endDate: event?.endDate, startDate: event?.startDate, title: event?.title };
      })
      .toEqual({ endDate: day(3), startDate: day(0), title: 'Conference (renamed)' });
    const op = (await readPendingOps(spanApp.userDataDir)).find(
      (candidate) => candidate.eventId === 'evt-conference',
    );
    expect(op?.payload).toMatchObject({ endDate: day(3), startDate: day(0) });
  });

  it('saves a title change on an overnight event and keeps its times', async () => {
    const { cdp } = spanApp;
    const before = await stored('evt-night');
    await cdp.openEditor('[title^="Night shift"]');
    expect({
      end: await fieldValue('End date'),
      endTime: await fieldValue('End time'),
      start: await fieldValue('Date'),
      startTime: await fieldValue('Start time'),
    }).toEqual({ end: day(1), endTime: '01:00', start: day(0), startTime: '22:00' });
    await setField('Title', 'Night shift (renamed)');
    await cdp.clickButtonWithText('Save');
    await expect
      .poll(async () => {
        const event = await stored('evt-night');
        return { endUtc: event?.endUtc, startUtc: event?.startUtc, title: event?.title };
      })
      .toEqual({
        endUtc: before?.endUtc,
        startUtc: before?.startUtc,
        title: 'Night shift (renamed)',
      });
  });

  it('lengthens an all-day event through its end date, and a new start date carries the end along', async () => {
    const { cdp } = spanApp;
    await cdp.openEditor('[title^="Conference"]');
    await setField('End date', day(3));
    await cdp.clickButtonWithText('Save');
    await expect.poll(async () => (await stored('evt-conference'))?.endDate).toBe(day(4));
    await cdp.openEditor('[title^="Conference"]');
    await setField('Date', day(1));
    expect(await fieldValue('End date')).toBe(day(4));
    // Cleared mid-edit, the start still carries the end to the next date.
    await setField('Date', '');
    await setField('Date', day(2));
    expect(await fieldValue('End date')).toBe(day(5));
    await cdp.clickButtonWithText('Cancel');
  });
});

describe('collapsible all-day lane', () => {
  const LANE_ROW = 24;
  const LANE_PADDING = 8;
  let laneApp: App;

  beforeAll(async () => {
    // Five date-only tasks on one day: the lane grows to five rows when
    // expanded and caps at three (two chips + "+3 more") when collapsed.
    laneApp = await launchApp({
      ...seed,
      events: [],
      tasks: Array.from({ length: 5 }, (_, index) => {
        const n = index + 1;
        return new TaskRecord({
          accountId: 'acc-e2e',
          dueDate: todayLocalIso(),
          id: `chore-${n}`,
          listId: 'list-e2e',
          provider: 'google',
          status: 'needsAction',
          title: `Chore ${n}`,
          updatedAt: 1,
        });
      }),
    });
  }, 60_000);

  afterEach(async (context) => {
    if (context.task.result?.state === 'fail') {
      await laneApp?.dump(context.task.name);
    }
  });

  afterAll(async () => {
    await laneApp?.stop();
  });

  it('collapses to three rows with "+N more", persists the choice and expands again', async () => {
    const { cdp } = laneApp;
    const laneHeight = () =>
      cdp.eval<number>(
        `document.querySelector('[data-testid="all-day-lane"]').getBoundingClientRect().height`,
      );
    const visibleChores = () =>
      cdp.eval<number>(`document.querySelectorAll('[title^="Chore "]').length`);
    await cdp.locate('[title="Chore 5"]');
    // Expanded by default: every chip drawn, no "+N more", nothing to scroll.
    expect(await laneHeight()).toBe(5 * LANE_ROW + LANE_PADDING);
    expect(
      await cdp.eval<boolean>(`(() => {
        const scroller = document.querySelector('[data-testid="all-day-scroller"]');
        return scroller.scrollHeight === scroller.clientHeight;
      })()`),
    ).toBe(true);
    expect(await visibleChores()).toBe(5);
    expect(await cdp.eval(`!!document.querySelector('[data-testid="all-day-more"]')`)).toBe(false);

    const toggle = () =>
      cdp.eval<string | null>(
        `document.querySelector('[data-testid="all-day-toggle"]')?.getAttribute('aria-expanded') ?? null`,
      );
    expect(await toggle()).toBe('true');
    const less = await cdp.locate('[data-testid="all-day-toggle"]');
    await cdp.click(less.x, less.y);
    await expect
      .poll(() => readDeviceSetting(laneApp.userDataDir, 'viewPreferences'))
      .toEqual({ allDayLaneCollapsed: true });
    await cdp.waitFor(
      `document.querySelector('[data-testid="all-day-more"]')?.textContent === '+3 more'`,
    );
    expect(await laneHeight()).toBe(3 * LANE_ROW + LANE_PADDING);
    expect(await visibleChores()).toBe(2);
    // The chevron stays where it was, turned down.
    expect(await toggle()).toBe('false');

    const more = await cdp.locate('[data-testid="all-day-more"]');
    await cdp.click(more.x, more.y);
    await expect
      .poll(() => readDeviceSetting(laneApp.userDataDir, 'viewPreferences'))
      .toEqual({ allDayLaneCollapsed: false });
    await cdp.waitFor(`document.querySelectorAll('[title^="Chore "]').length === 5`);
    expect(await laneHeight()).toBe(5 * LANE_ROW + LANE_PADDING);
    expect(await cdp.eval(`!!document.querySelector('[data-testid="all-day-more"]')`)).toBe(false);

    // The chevron collapses and expands it too.
    const down = await cdp.locate('[data-testid="all-day-toggle"]');
    await cdp.click(down.x, down.y);
    await cdp.waitFor(`!!document.querySelector('[data-testid="all-day-more"]')`);
    const up = await cdp.locate('[data-testid="all-day-toggle"]');
    await cdp.click(up.x, up.y);
    await cdp.waitFor(`document.querySelectorAll('[title^="Chore "]').length === 5`);
    expect(await toggle()).toBe('true');
  });
});

/** An open Google task in the seed's list; `undefined` leaves it undated. */
const chore = (id: string, title: string, dueDate: string | undefined) =>
  new TaskRecord({
    accountId: 'acc-e2e',
    ...(dueDate === undefined ? {} : { dueDate }),
    id,
    listId: 'list-e2e',
    provider: 'google',
    status: 'needsAction',
    title,
    updatedAt: 1,
  });

describe('a fold list in a short window', () => {
  let shortApp: App;

  beforeAll(async () => {
    // Twelve late and twelve undated tasks in the shortest window the app
    // allows: the undated chip sits on the lane's second row, lower still.
    shortApp = await launchApp(
      {
        ...seed,
        events: [],
        tasks: Array.from({ length: 12 }, (_, index) => [
          chore(`late-${String(index + 1)}`, `Late ${String(index + 1)}`, localIsoDaysAgo(1)),
          chore(`loose-${String(index + 1)}`, `Loose ${String(index + 1)}`, undefined),
        ]).flat(),
      },
      { window: { height: 400, width: 1024 } },
    );
  }, 60_000);

  afterEach(async (context) => {
    if (context.task.result?.state === 'fail') {
      await shortApp?.dump(context.task.name);
    }
  });

  afterAll(async () => {
    await shortApp?.stop();
  });

  it('fits the room below its chip and scrolls to its last row', async () => {
    const { cdp } = shortApp;
    const chip = await cdp.locate('[data-testid="all-day-fold-undated"]');
    await cdp.click(chip.x, chip.y);
    await cdp.waitFor(`!!document.querySelector('[data-testid="all-day-fold-list-undated"]')`);
    const fits = await cdp.eval<boolean>(`(() => {
      const panel = document
        .querySelector('[data-testid="all-day-fold-list-undated"]')
        .closest('[role="dialog"]')
        .getBoundingClientRect();
      return panel.bottom <= window.innerHeight;
    })()`);
    expect(fits).toBe(true);
    const lastShown = await cdp.eval<boolean>(`(() => {
      const rows = document.querySelectorAll('[data-testid^="fold-task-"]');
      const last = rows[rows.length - 1];
      last.scrollIntoView({ block: 'nearest' });
      const box = last.getBoundingClientRect();
      return rows.length === 12 && box.bottom <= window.innerHeight && box.top >= 0;
    })()`);
    expect(lastShown).toBe(true);
    await cdp.pressEscape();
  });
});

describe("today's backlog and a long all-day lane", () => {
  let backlogApp: App;

  beforeAll(async () => {
    // Three late tasks and two undated ones (each group folds into one
    // chip on today) and twenty chores due today: today's column needs
    // 22 rows, more than a third of any window holds.
    backlogApp = await launchApp({
      ...seed,
      events: [],
      tasks: [
        chore('late-1', 'Late 1', localIsoDaysAgo(3)),
        chore('late-2', 'Late 2', localIsoDaysAgo(2)),
        chore('late-3', 'Late 3', localIsoDaysAgo(1)),
        chore('loose-1', 'Loose 1', undefined),
        chore('loose-2', 'Loose 2', undefined),
        ...Array.from({ length: 20 }, (_, index) =>
          chore(`today-${String(index + 1)}`, `Chore ${String(index + 1)}`, todayLocalIso()),
        ),
      ],
    });
  }, 60_000);

  afterEach(async (context) => {
    if (context.task.result?.state === 'fail') {
      await backlogApp?.dump(context.task.name);
    }
  });

  afterAll(async () => {
    await backlogApp?.stop();
  });

  const foldText = (fold: string) =>
    backlogApp.cdp.eval<string | null>(
      `document.querySelector('[data-testid="all-day-fold-${fold}"]')?.textContent ?? null`,
    );
  const taskById = async (id: string) =>
    (await readTasks(backlogApp.userDataDir)).find((task) => task.id === id);

  it('folds each backlog group into one chip on today', async () => {
    const { cdp } = backlogApp;
    await cdp.locate('[data-testid="all-day-fold-overdue"]');
    expect(await foldText('overdue')).toContain('3 overdue');
    expect(await foldText('undated')).toBe('2 no date');
    // No chip of their own, on today or on their past days.
    expect(
      await cdp.eval<number>(
        `document.querySelectorAll('[title^="Late "], [title^="Loose "]').length`,
      ),
    ).toBe(0);
    const inTodayColumn = await cdp.eval<boolean>(`(() => {
      const cell = document.querySelector('[data-testid="today-header"]').getBoundingClientRect();
      return ['overdue', 'undated'].every((fold) => {
        const chip = document
          .querySelector('[data-testid="all-day-fold-' + fold + '"]')
          .getBoundingClientRect();
        return chip.left >= cell.left - 1 && chip.right <= cell.right + 1;
      });
    })()`);
    expect(inTodayColumn).toBe(true);
  });

  it('caps the expanded lane at a third of the view and scrolls the rest inside it', async () => {
    const { cdp } = backlogApp;
    const geometry = () =>
      cdp.eval<{
        clientHeight: number;
        grid: number;
        lane: number;
        scrollHeight: number;
        scrolls: boolean;
        view: number;
      }>(`(() => {
        const lane = document.querySelector('[data-testid="all-day-lane"]');
        const scroller = document.querySelector('[data-testid="all-day-scroller"]');
        return {
          clientHeight: scroller.clientHeight,
          grid: document.querySelector('[data-testid="week-scroller"]').getBoundingClientRect().height,
          lane: lane.getBoundingClientRect().height,
          scrollHeight: scroller.scrollHeight,
          scrolls: lane.hasAttribute('data-scrolls'),
          view: document.querySelector('[data-testid="week-view"]').clientHeight,
        };
      })()`);
    const before = await geometry();
    const rows = Math.max(3, Math.floor(before.view / 3 / 24));
    // Whole rows, then half of the next chip (the hairline under it included).
    expect(before).toMatchObject({ lane: rows * 24 + 15, scrolls: true });
    expect(before.scrollHeight).toBe(22 * 24 + 7);
    expect(before.grid).toBeGreaterThan(before.view / 2);
    // The last chore scrolls into view inside the lane, not the window.
    await cdp.locate('[title="Chore 20"]');
    const shown = await cdp.eval<boolean>(`(() => {
      const chip = document.querySelector('[title="Chore 20"]').getBoundingClientRect();
      const lane = document.querySelector('[data-testid="all-day-scroller"]').getBoundingClientRect();
      return chip.top >= lane.top && chip.bottom <= lane.bottom;
    })()`);
    expect(shown).toBe(true);
    expect((await geometry()).lane).toBe(before.lane);

    // A diagonal swipe that starts a pan scrolls the lane it began over,
    // not the hours. (Synthetic events: the app's listener moves both.)
    await cdp.eval(`document.querySelector('[data-testid="all-day-scroller"]').scrollTop = 0`);
    const scrollTops = () =>
      cdp.eval<{ grid: number; lane: number }>(`({
        grid: document.querySelector('[data-testid="week-scroller"]').scrollTop,
        lane: document.querySelector('[data-testid="all-day-scroller"]').scrollTop,
      })`);
    const start = await scrollTops();
    await cdp.wheelBurst('[data-testid="all-day-scroller"]', {
      count: 2,
      deltaX: 12,
      deltaY: 10,
      gapMs: 16,
    });
    const moved = await scrollTops();
    expect(moved.grid).toBe(start.grid);
    expect(moved.lane).toBeGreaterThan(start.lane);
    // The short pan settles back onto the same week.
    await cdp.waitFor(
      `getComputedStyle(document.querySelector('[data-testid="week-view"]')).getPropertyValue('--pan-x').trim() === '0px'`,
    );
    await cdp.eval(`document.querySelector('[data-testid="all-day-scroller"]').scrollTop = 0`);
  });

  it("lists a fold's tasks and keeps a ticked one in its place", async () => {
    const { cdp } = backlogApp;
    const chip = await cdp.locate('[data-testid="all-day-fold-overdue"]');
    await cdp.click(chip.x, chip.y);
    await cdp.waitFor(`!!document.querySelector('[data-testid="all-day-fold-list-overdue"]')`);
    const rows = () =>
      cdp.eval<Array<string>>(
        `[...document.querySelectorAll('[data-testid^="fold-task-"]')].map((row) => row.dataset.testid)`,
      );
    // Oldest due day first, as in the inbox.
    expect(await rows()).toEqual(['fold-task-late-1', 'fold-task-late-2', 'fold-task-late-3']);
    // Scoped to the list: the rail, when the window is wide enough for it,
    // has a checkbox of the same name under the list's backdrop.
    const box = await cdp.locate(
      '[data-testid="all-day-fold-list-overdue"] [aria-label="Mark done: Late 2"]',
    );
    await cdp.click(box.x, box.y);
    await expect.poll(async () => (await taskById('late-2'))?.status).toBe('completed');
    // Still listed, now to reopen; the list stays open and the chip counts two.
    await cdp.waitFor(
      `!!document.querySelector('[data-testid="all-day-fold-list-overdue"] [aria-label="Reopen: Late 2"]')`,
    );
    expect(await rows()).toEqual(['fold-task-late-1', 'fold-task-late-2', 'fold-task-late-3']);
    expect(await foldText('overdue')).toContain('2 overdue');
    // A row opens its task in the side panel and the list closes.
    const title = await cdp.locate('[data-testid="fold-task-late-1"] button + button');
    await cdp.click(title.x, title.y);
    await cdp.waitFor(`!!document.querySelector('[data-testid="editor"]')`);
    expect(
      await cdp.eval<boolean>(
        `!!document.querySelector('[data-testid="all-day-fold-list-overdue"]')`,
      ),
    ).toBe(false);
    await cdp.clickButtonWithText('Cancel');
    await cdp.waitFor(`!document.querySelector('[data-testid="editor"]')`);
  });

  it('drops nothing from a press inside the list, and Escape mid-drag only ends the drag', async () => {
    const { cdp } = backlogApp;
    const listOpen = () =>
      cdp.eval<boolean>(`!!document.querySelector('[data-testid="all-day-fold-list-overdue"]')`);
    const due = (await taskById('late-3'))?.dueDate;
    const chip = await cdp.locate('[data-testid="all-day-fold-overdue"]');
    await cdp.click(chip.x, chip.y);
    await cdp.waitFor(`!!document.querySelector('[data-testid="all-day-fold-list-overdue"]')`);
    // The keyboard starts on the first row.
    expect(
      await cdp.eval<string | null>(
        `document.activeElement?.closest('[data-testid^="fold-task-"]')?.dataset.testid ?? null`,
      ),
    ).toBe('fold-task-late-1');

    // Past the click threshold but never out of the list: no drop, no click.
    const row = await cdp.locate('[data-testid="fold-task-late-3"] button + button');
    await cdp.mouse('mousePressed', row.x, row.y);
    await cdp.mouse('mouseMoved', row.x + 6, row.y + 2);
    await cdp.mouse('mouseMoved', row.x + 12, row.y + 3);
    await cdp.mouse('mouseReleased', row.x + 12, row.y + 3);
    expect(await listOpen()).toBe(true);
    expect(await cdp.eval<boolean>(`!!document.querySelector('[data-testid="editor"]')`)).toBe(
      false,
    );

    // Pulled out over the grid, Escape ends the drag and the list comes back.
    const away = await cdp.eval<{ x: number; y: number }>(`(() => {
      const list = document
        .querySelector('[data-testid="all-day-fold-list-overdue"]')
        .getBoundingClientRect();
      const grid = document.querySelector('[data-testid="week-scroller"]').getBoundingClientRect();
      return {
        x: Math.round(list.left - grid.left > 120 ? grid.left + 90 : list.right + 40),
        y: Math.round(grid.top + grid.height / 2),
      };
    })()`);
    // A sideways wheel over the list's backdrop leaves the days where they are.
    const todayLeft = () =>
      cdp.eval<number>(
        `document.querySelector('[data-testid="today-header"]').getBoundingClientRect().left`,
      );
    const before = await todayLeft();
    await cdp.wheel(away.x, away.y, 600, 0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await todayLeft()).toBe(before);
    expect(await listOpen()).toBe(true);

    await cdp.mouse('mousePressed', row.x, row.y);
    for (let step = 1; step <= 6; step += 1) {
      await cdp.mouse(
        'mouseMoved',
        Math.round(row.x + ((away.x - row.x) * step) / 6),
        Math.round(row.y + ((away.y - row.y) * step) / 6),
      );
    }
    await cdp.waitFor(`!!document.querySelector('[data-testid="drag-ghost"]')`);
    await cdp.pressEscape();
    await cdp.waitFor(`!document.querySelector('[data-testid="drag-ghost"]')`);
    expect(await listOpen()).toBe(true);
    await cdp.mouse('mouseReleased', away.x, away.y);
    expect(await listOpen()).toBe(true);
    expect((await taskById('late-3'))?.dueDate).toBe(due);

    // Escape now closes the list and gives the focus back to its chip.
    await cdp.pressEscape();
    await cdp.waitFor(`!document.querySelector('[data-testid="all-day-fold-list-overdue"]')`);
    expect(await cdp.eval<string | null>(`document.activeElement?.dataset.testid ?? null`)).toBe(
      'all-day-fold-overdue',
    );
    expect((await taskById('late-3'))?.dueDate).toBe(due);
  });

  it('drags a row from a fold list onto the lane and dates it', async () => {
    const { cdp } = backlogApp;
    // Measured before the list opens: its backdrop covers the calendar.
    const column = await cdp.locate('[data-testid="today-header"]');
    const lane = await cdp.locate('[data-testid="all-day-lane"]');
    const chip = await cdp.locate('[data-testid="all-day-fold-overdue"]');
    await cdp.click(chip.x, chip.y);
    const row = await cdp.locate('[data-testid="fold-task-late-3"] button + button');
    await cdp.drag(row, { x: column.x, y: lane.y });
    await expect.poll(async () => (await taskById('late-3'))?.dueDate).toBe(todayLocalIso());
    // A drop, not a click: the list closed and no editor opened.
    await cdp.waitFor(`!document.querySelector('[data-testid="all-day-fold-list-overdue"]')`);
    expect(await cdp.eval<boolean>(`!!document.querySelector('[data-testid="editor"]')`)).toBe(
      false,
    );
    // One late task left: it is its own chip again, no fold.
    await cdp.locate('[data-overdue][title^="Late 1"]');
    expect(await foldText('overdue')).toBe(null);
  });
});

describe('a reloaded window', () => {
  let reloadApp: App;

  beforeAll(async () => {
    reloadApp = await launchApp(seed);
  }, 60_000);

  afterEach(async (context) => {
    if (context.task.result?.state === 'fail') {
      await reloadApp?.dump(context.task.name);
    }
  });

  afterAll(async () => {
    await reloadApp?.stop();
  });

  it('still hears about changes made elsewhere after ⌘R', async () => {
    const { cdp } = reloadApp;
    await cdp.waitFor(`!!document.querySelector('[title^="Standup meeting"]')`);
    // The reloaded page numbers its requests from 0 again. The old page's
    // invalidations stream stayed open under the same client id, and the
    // server drops a request whose id is still running — so the new
    // page's own subscription never started.
    await cdp.send('Page.reload', {});
    await cdp.waitFor(`!!document.querySelector('[title^="Standup meeting"]')`);
    // A change the window did not make: hiding Work in the Settings window
    // reaches it only through its invalidations stream.
    const settings = await reloadApp.openSettings('accounts');
    const work = `[...document.querySelectorAll('input[type="checkbox"]')].find(b => b.parentElement?.textContent?.includes('Work') && b.checked)`;
    await settings.waitFor(`!!${work}`);
    await settings.eval(`${work}?.click()`);
    await cdp.waitFor(`!document.querySelector('[title^="Standup meeting"]')`, 20_000);
    await reloadApp.closeSettings();
  });

  it('stays a client when a navigation is refused', async () => {
    const { cdp } = reloadApp;
    // main.ts refuses a navigation off the app's own page in will-navigate,
    // after Electron has already reported did-start-navigation: the
    // document stays, and so must its streams.
    await cdp.eval(`void (window.__stillHere = true)`);
    await cdp.eval(`void (location.href = 'https://example.com/')`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await cdp.eval<boolean>('window.__stillHere === true')).toBe(true);
    // Showing Work again in Settings reaches it only through its
    // invalidations stream.
    const settings = await reloadApp.openSettings('accounts');
    const work = `[...document.querySelectorAll('input[type="checkbox"]')].find(b => b.parentElement?.textContent?.includes('Work') && !b.checked)`;
    await settings.waitFor(`!!${work}`);
    await settings.eval(`${work}?.click()`);
    await cdp.waitFor(`!!document.querySelector('[title^="Standup meeting"]')`, 20_000);
    await reloadApp.closeSettings();
  });
});
