import { type AppleCalendarJson } from '@calendar/apple-calendar';
import {
  Account,
  APPLE_CALENDAR_ACCOUNT_ID,
  CalendarInfo,
  EventRecord,
  TaskListInfo,
  TaskRecord,
} from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  type AppleCalendarFixture,
  type App,
  launchApp,
  localDayAt,
  localIsoDaysAgo,
  readEvents,
} from './harness.ts';
import type { PageKit } from './page.ts';

// Everything is placed relative to today at local hours from 09:00 to
// 18:00, on the days the app draws. A Google account without a token
// (writes stay queued) and the in-memory EventKit for the Apple event.
const HOUR_MS = 60 * 60 * 1000;
/** The given local hour, `days` from today. */
const dayAt = (days: number, hour: number): number => localDayAt(days, hour);

const account = new Account({
  contactsEnabled: false,
  createdAt: 1,
  email: 'e2e@example.com',
  id: 'acc-e2e',
  provider: 'google',
  status: 'ok',
  tasksEnabled: true,
});

const calendar = (overrides: Partial<CalendarInfo>) =>
  new CalendarInfo({
    accessRole: 'owner',
    accountId: 'acc-e2e',
    colorHex: '#3b82f6',
    id: 'cal-work',
    isPrimary: true,
    isVisible: true,
    provider: 'google',
    summary: 'Work',
    timeZone: 'UTC',
    ...overrides,
  });

const event = (id: string, title: string, start: number, overrides: Partial<EventRecord> = {}) =>
  new EventRecord({
    accountId: 'acc-e2e',
    calendarId: 'cal-work',
    endUtc: start + HOUR_MS,
    etag: `"${id}"`,
    id,
    isAllDay: false,
    startTimeZone: 'UTC',
    startUtc: start,
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    title,
    updatedAt: 1,
    ...overrides,
  });

const appleHome: AppleCalendarJson = {
  allowsModifications: true,
  colorHex: '#34c759',
  id: 'ek-home',
  isDefault: true,
  sourceTitle: 'iCloud',
  sourceType: 'calDAV',
  title: 'Home',
  type: 'calDAV',
};

const appleFixture: AppleCalendarFixture = {
  calendars: [appleHome],
  events: [
    {
      event: {
        calendarId: 'ek-home',
        endUtc: dayAt(3, 13),
        hasRecurrence: false,
        id: 'ek-pier',
        isAllDay: false,
        isDetached: false,
        startUtc: dayAt(3, 12),
        status: 'confirmed',
        timeZone: 'UTC',
        title: 'Harbour lunch at the pier',
        updatedAt: 1,
      },
    },
  ],
};

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
  ],
  calendars: [
    calendar({}),
    calendar({ id: 'cal-hidden', isPrimary: false, isVisible: false, summary: 'Hidden' }),
    calendar({
      accountId: APPLE_CALENDAR_ACCOUNT_ID,
      colorHex: '#34c759',
      id: 'ek-home',
      provider: 'apple',
      sourceTitle: 'iCloud',
      summary: 'Home',
    }),
  ],
  events: [
    // Weekly on the weekday after today's: the next occurrence is
    // tomorrow, whatever day the run is on.
    event('evt-standup', 'Harbour standup', dayAt(-20, 9), { recurrence: ['RRULE:FREQ=WEEKLY'] }),
    // Evening: below the hours the time grid rests on.
    event('evt-planning', 'Harbour planning', dayAt(2, 18), { location: 'Café Hafen' }),
    event('evt-retro', 'Harbour retro', dayAt(-10, 10)),
    event('evt-hidden', 'Harbour hidden', dayAt(3, 10), { calendarId: 'cal-hidden' }),
    event('evt-cancelled', 'Harbour cancelled', dayAt(2, 12), { status: 'cancelled' }),
  ],
  taskLists: [
    new TaskListInfo({
      accountId: 'acc-e2e',
      id: 'list-e2e',
      isVisible: true,
      provider: 'google',
      title: 'Errands',
    }),
    new TaskListInfo({
      accountId: 'acc-e2e',
      id: 'list-hidden',
      isVisible: false,
      provider: 'google',
      title: 'Someday',
    }),
  ],
  tasks: [
    new TaskRecord({
      accountId: 'acc-e2e',
      dueDate: localIsoDaysAgo(-1),
      id: 'task-checklist',
      listId: 'list-e2e',
      provider: 'google',
      status: 'needsAction',
      title: 'Harbour checklist',
      updatedAt: 1,
    }),
    new TaskRecord({
      accountId: 'acc-e2e',
      completedAt: dayAt(-2, 10),
      id: 'task-receipts',
      listId: 'list-e2e',
      provider: 'google',
      status: 'completed',
      title: 'Harbour receipts',
      updatedAt: 1,
    }),
    new TaskRecord({
      accountId: 'acc-e2e',
      id: 'task-hidden',
      listId: 'list-hidden',
      provider: 'google',
      status: 'needsAction',
      title: 'Harbour hidden task',
      updatedAt: 1,
    }),
  ],
};

const INPUT = '[data-testid="search-input"]';
const panelKind = ($: PageKit) => $.el('[data-testid="panel"]')?.dataset.panelKind;
/** The results answer the text in the field (not an earlier query's). */
const settled = ($: PageKit) =>
  $.el('[data-testid="search-results"]')?.getAttribute('aria-busy') === 'false';

describe('Search', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { appleCalendar: { fixture: appleFixture } });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  /** The result titles of one group, in order. */
  const titles = (group: 'past' | 'tasks' | 'upcoming') =>
    app.cdp.evaluate(
      ($, name: string) =>
        $.all(`[data-testid="search-group-${name}"] [data-testid="search-title"]`).map(
          (title) => title.textContent,
        ),
      group,
    );

  /** Types over whatever the field holds and waits for that query's results. */
  const search = async (text: string) => {
    const { cdp } = app;
    await cdp.evaluate(($, input: string) => $.el<HTMLInputElement>(input)!.select(), INPUT);
    await cdp.type(INPUT, text);
    await cdp.waitUntil(
      ($, input: string, want: string) => $.el<HTMLInputElement>(input)!.value === want,
      INPUT,
      text,
    );
    await cdp.waitUntil(settled);
  };

  /** Clicks the result row with this title. */
  const openResult = async (title: string) => {
    const { cdp } = app;
    const index = await cdp.evaluate(
      ($, want: string) =>
        $.all('[data-search-result]').findIndex(
          (row) => row.querySelector('[data-testid="search-title"]')?.textContent === want,
        ),
      title,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const row = await cdp.locate('[data-search-result]', { index });
    await cdp.click(row.x, row.y);
  };

  it('opens on ⌘F and lists what matches: upcoming, past and tasks, a series once', async () => {
    const { cdp } = app;
    await cdp.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }));
    });
    await cdp.waitUntil(($, input: string) => document.activeElement === $.el(input), INPUT);
    expect(await cdp.evaluate(panelKind)).toBe('search');
    expect(await cdp.evaluate(($) => $.has('[data-testid="search-hint"]'))).toBe(true);
    expect(
      await cdp.evaluate(($) =>
        $.el('[data-testid="search-toggle"]')!.getAttribute('aria-pressed'),
      ),
    ).toBe('true');

    await search('harbour');
    await cdp.waitUntil(($) => $.has('[data-testid="search-group-upcoming"]'));
    // Hidden calendars and lists, and cancelled events, are not found.
    expect(await titles('upcoming')).toEqual([
      'Harbour standup',
      'Harbour planning',
      'Harbour lunch at the pier',
    ]);
    expect(await titles('past')).toEqual(['Harbour retro']);
    expect(await titles('tasks')).toEqual(['Harbour checklist', 'Harbour receipts']);
    // The weekly series is one row, at its next occurrence, marked as repeating.
    const standup = await cdp.evaluate(($) => {
      const row = $.all('[data-testid="search-event"]').find(
        (candidate) =>
          candidate.querySelector('[data-testid="search-title"]')!.textContent ===
          'Harbour standup',
      )!;
      return JSON.stringify({
        repeats: !!row.querySelector('[data-testid="search-repeats"]'),
        when: row.querySelector('[data-testid="search-when"]')!.textContent,
      });
    });
    const tomorrow = new Date(dayAt(1, 9)).toLocaleDateString('en-US', {
      day: 'numeric',
      month: 'short',
      weekday: 'short',
    });
    expect(JSON.parse(standup)).toMatchObject({ repeats: true });
    expect((JSON.parse(standup) as { when: string }).when.startsWith(tomorrow)).toBe(true);
  });

  it('needs every word, in any field, accents and case aside', async () => {
    const { cdp } = app;
    await search('CAFE harbour');
    expect(await titles('upcoming')).toEqual(['Harbour planning']);
    expect(await cdp.evaluate(($) => $.has('[data-testid="search-group-tasks"]'))).toBe(false);
    await search('harbour nowhere');
    expect(await cdp.evaluate(($) => $.el('[data-testid="search-empty"]')?.textContent)).toContain(
      'Nothing matches “harbour nowhere”.',
    );
  });

  it('acts on Enter and the arrow keys only once the results answer what was typed', async () => {
    const { cdp } = app;
    const keydown = ($: PageKit, input: string, key: string) =>
      $.el(input)!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }));
    await search('harbour');
    // Typed over and acted on at once, inside the debounce: the list still
    // shows the results for "harbour", Harbour standup on top.
    await cdp.evaluate(($, input: string) => $.el<HTMLInputElement>(input)!.select(), INPUT);
    await cdp.type(INPUT, 'harbour lunch');
    await cdp.evaluate(keydown, INPUT, 'ArrowDown');
    expect(
      await cdp.evaluate(($, input: string) => document.activeElement === $.el(input), INPUT),
    ).toBe(true);
    await cdp.evaluate(keydown, INPUT, 'Enter');
    await cdp.waitUntil(
      ($) => $.text('[data-testid="inspector-title"]') === 'Harbour lunch at the pier',
    );
    await cdp.clickTestId('inspector-back');
    await cdp.waitUntil(($) => $.el('[data-testid="panel"]')?.dataset.panelKind === 'search');
  });

  it('opens an event result on its day, outlined in the grid, with a way back to the results', async () => {
    const { cdp } = app;
    await search('harbour');
    await openResult('Harbour planning');
    await cdp.waitUntil(($) => $.text('[data-testid="inspector-title"]') === 'Harbour planning');
    expect(await cdp.evaluate(panelKind)).toBe('inspector');
    // The grid moved to its day and scrolled the evening into view.
    await cdp.waitUntil(($) => {
      const block = $.el('[data-selected][title^="Harbour planning"]');
      const scroller = $.el('[data-testid="week-scroller"]');
      if (!block || !scroller) {
        return false;
      }
      const b = block.getBoundingClientRect();
      const s = scroller.getBoundingClientRect();
      return b.top >= s.top && b.top < s.bottom;
    });

    await cdp.clickTestId('inspector-back');
    await cdp.waitUntil(($) => $.el('[data-testid="panel"]')?.dataset.panelKind === 'search');
    expect(
      await cdp.evaluate(($, input: string) => $.el<HTMLInputElement>(input)!.value, INPUT),
    ).toBe('harbour');
    expect(await titles('upcoming')).toEqual([
      'Harbour standup',
      'Harbour planning',
      'Harbour lunch at the pier',
    ]);
  });

  it('opens a task result in its editor; Escape steps back to the results, then closes them', async () => {
    const { cdp } = app;
    await openResult('Harbour checklist');
    await cdp.waitUntil(($) => $.text('[data-testid="editor-title"]') === 'Edit task');
    await cdp.pressEscape();
    await cdp.waitUntil(($) => $.el('[data-testid="panel"]')?.dataset.panelKind === 'search');
    await cdp.waitUntil(settled);
    expect(await titles('tasks')).toEqual(['Harbour checklist', 'Harbour receipts']);
    await cdp.pressEscape();
    await cdp.waitUntil(($) => $.el('[data-testid="panel"]')?.dataset.panelKind !== 'search');
    expect(
      await cdp.evaluate(($) =>
        $.el('[data-testid="search-toggle"]')!.getAttribute('aria-pressed'),
      ),
    ).toBe(null);
  });

  it('moves a panned week to a result in another week', async () => {
    const { cdp } = app;
    const title = ($: PageKit) => $.text('[data-testid="toolbar-title"]');
    // A trackpad pan rolls the week by days; the window then stops following the focused day.
    const before = await cdp.evaluate(title);
    await cdp.wheelBurst('[data-testid="week-scroller"]', { count: 12, deltaX: 240 });
    await cdp.waitUntil(
      ($, was: string) => $.text('[data-testid="toolbar-title"]') !== was,
      before,
    );
    await cdp.clickTestId('search-toggle');
    await cdp.waitUntil(
      ($) =>
        $.el('[data-testid="search-results"]')?.getAttribute('aria-busy') === 'false' &&
        $.has('[data-testid="search-group-past"]'),
    );
    // Ten days back, outside the panned week.
    await openResult('Harbour retro');
    await cdp.waitUntil(($) => $.text('[data-testid="inspector-title"]') === 'Harbour retro');
    await cdp.waitUntil(($) => $.has('[data-selected][title^="Harbour retro"]'));
    // Leave the results closed and the grid on this week for the next test.
    await cdp.pressEscape();
    await cdp.waitUntil(($) => $.el('[data-testid="panel"]')?.dataset.panelKind === 'search');
    await cdp.pressEscape();
    await cdp.waitUntil(($) => $.el('[data-testid="panel"]')?.dataset.panelKind !== 'search');
    await cdp.clickTestId('today');
  });

  it('drops an event deleted from its result, and the toolbar button reopens the same query', async () => {
    const { cdp } = app;
    await cdp.clickTestId('search-toggle');
    await cdp.waitUntil(($) => $.el('[data-testid="panel"]')?.dataset.panelKind === 'search');
    expect(
      await cdp.evaluate(($, input: string) => $.el<HTMLInputElement>(input)!.value, INPUT),
    ).toBe('harbour');
    await cdp.waitUntil(
      ($) =>
        $.el('[data-testid="search-results"]')?.getAttribute('aria-busy') === 'false' &&
        $.has('[data-testid="search-group-past"]'),
    );
    await openResult('Harbour retro');
    await cdp.waitUntil(($) => $.text('[data-testid="inspector-title"]') === 'Harbour retro');
    await cdp.clickButtonWithText('Delete');
    await cdp.confirmDelete();
    // A delete made from a result goes back to the results, without it.
    await cdp.waitUntil(($) => $.el('[data-testid="panel"]')?.dataset.panelKind === 'search');
    await cdp.waitUntil(($) => !$.has('[data-testid="search-group-past"]'));
    expect(await titles('upcoming')).toHaveLength(3);
    expect((await readEvents(app.userDataDir)).some((row) => row.id === 'evt-retro')).toBe(false);

    // The toolbar button closes it again.
    await cdp.clickTestId('search-toggle');
    await cdp.waitUntil(($) => $.el('[data-testid="panel"]')?.dataset.panelKind !== 'search');
  });
});
