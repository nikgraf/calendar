import { Account, CalendarInfo, EventRecord, TaskListInfo, TaskRecord } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp } from './harness.ts';
import type { PageKit } from './page.ts';

// Search filters: a sentence read into chips (the fixture model, so the
// sentences are in its grammar — `terms | from..to | location | people |
// calendar | kind`, days as ±N from today), the chips edited by hand, the
// turns with Undo, Clear, and Enter routed by the words. The app runs in
// UTC (TZ) and every day here is a UTC day — the seeds, the due dates and
// the dates typed into the filter — so one basis holds at any hour.
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const dayAt = (days: number, hour: number): number => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour) + days * DAY_MS;
};
/** The UTC day `days` from today, as `YYYY-MM-DD`. */
const utcDay = (days: number): string => new Date(dayAt(days, 12)).toISOString().slice(0, 10);

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

const list = (id: string, title: string) =>
  new TaskListInfo({ accountId: 'acc-e2e', id, isVisible: true, provider: 'google', title });

const task = (id: string, title: string, listId: string, due: number) =>
  new TaskRecord({
    accountId: 'acc-e2e',
    dueDate: utcDay(due),
    id,
    listId,
    provider: 'google',
    status: 'needsAction',
    title,
    updatedAt: 1,
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
      tasksEnabled: true,
    }),
  ],
  calendars: [calendar({}), calendar({ id: 'cal-family', isPrimary: false, summary: 'Family' })],
  events: [
    // Weekly from three weeks back: tomorrow ahead, a week ago behind.
    event('evt-standup', 'Harbour standup', dayAt(-20, 9), { recurrence: ['RRULE:FREQ=WEEKLY'] }),
    event('evt-planning', 'Harbour planning', dayAt(2, 17), { location: 'Café Hafen' }),
    event('evt-retro', 'Harbour retro', dayAt(-10, 10)),
    event('evt-walk', 'Harbour walk', dayAt(3, 12), {
      attendees: [
        { displayName: 'Anna Example', email: 'anna@example.com', responseStatus: 'accepted' },
      ],
      calendarId: 'cal-family',
    }),
  ],
  taskLists: [list('list-errands', 'Errands'), list('list-groceries', 'Groceries')],
  tasks: [
    task('task-checklist', 'Harbour checklist', 'list-errands', 1),
    task('task-fish', 'Harbour fish', 'list-groceries', 2),
  ],
};

const INPUT = '[data-testid="search-input"]';
const settled = ($: PageKit) =>
  $.el('[data-testid="search-results"]')?.getAttribute('aria-busy') === 'false';
const turns = ($: PageKit) => $.count('[data-testid="search-turn"]');
const fieldIs = ($: PageKit, input: string, text: string) => $.value(input) === text;
const enter = ($: PageKit, input: string) =>
  $.el(input)!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));

describe('Search filters', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { env: { TZ: 'UTC' }, model: 'fixture' });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  const titles = (group: 'past' | 'tasks' | 'upcoming') =>
    app.cdp.evaluate(
      ($, shown: string) =>
        $.all(`[data-testid="search-group-${shown}"] [data-testid="search-title"]`).map(
          (title) => title.textContent,
        ),
      group,
    );

  /** Types over the field; waits for the words to be in it. */
  const typeOver = async (text: string) => {
    const { cdp } = app;
    await cdp.evaluate(($, input: string) => $.el<HTMLInputElement>(input)!.select(), INPUT);
    await cdp.type(INPUT, text);
    await cdp.waitUntil(fieldIs, INPUT, text);
  };

  it('reads a sentence into a date chip, leaves its words in the field, and takes it back on Undo', async () => {
    const { cdp } = app;
    await cdp.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true })),
    );
    await cdp.waitUntil(($) => $.has('[data-testid="search-input"]'));
    await typeOver('harbour | -15..-5');
    await cdp.clickTestId('search-ask');
    await cdp.waitUntil(($) => $.count('[data-testid="search-turn"]') === 1);
    await cdp.waitUntil(fieldIs, INPUT, 'harbour');
    await cdp.waitUntil(($) => $.has('[data-testid="search-chip-dates"]'));
    await cdp.waitUntil(settled);
    // A week ago's standup and the retro; nothing ahead, no task due in the range.
    await cdp.waitUntil(
      ($) =>
        !$.has('[data-testid="search-group-upcoming"]') &&
        $.has('[data-testid="search-group-past"]'),
    );
    expect(await titles('past')).toEqual(['Harbour standup', 'Harbour retro']);
    expect(await cdp.evaluate(($) => $.has('[data-testid="search-group-tasks"]'))).toBe(false);

    await cdp.clickTestId('search-undo');
    await cdp.waitUntil(($) => $.count('[data-testid="search-turn"]') === 0);
    await cdp.waitUntil(fieldIs, INPUT, 'harbour | -15..-5');
    expect(await cdp.evaluate(($) => $.has('[data-testid="search-chip-dates"]'))).toBe(false);
  });

  it('routes Enter by the words: a filter is read, plain words open the top result', async () => {
    const { cdp } = app;
    await typeOver('harbour | | hafen');
    expect(await cdp.evaluate(($, input: string) => $.el(input)!.dataset.routes, INPUT)).toBe(
      'ask',
    );
    await cdp.evaluate(enter, INPUT);
    await cdp.waitUntil(($) => $.has('[data-testid="search-chip-location"]'));
    expect(
      await cdp.evaluate(($) => $.el('[data-testid="search-chip-location"]')!.textContent),
    ).toBe('in hafen');
    await cdp.waitUntil(settled);
    await cdp.waitUntil(($) => $.has('[data-testid="search-group-upcoming"]'));
    expect(await titles('upcoming')).toEqual(['Harbour planning']);
    // A place leaves tasks out.
    expect(await cdp.evaluate(($) => $.has('[data-testid="search-group-tasks"]'))).toBe(false);

    // × takes the chip away; a person, read the same way.
    await cdp.evaluate(($) =>
      $.el('[data-testid="search-chip-location"]')!
        .parentElement!.querySelector<HTMLElement>('[data-testid="search-chip-remove"]')!
        .click(),
    );
    await cdp.waitUntil(($) => !$.has('[data-testid="search-chip-location"]'));
    await typeOver('harbour | | | anna');
    await cdp.evaluate(enter, INPUT);
    await cdp.waitUntil(($) => $.has('[data-testid="search-chip-people"]'));
    await cdp.waitUntil(settled);
    await cdp.waitUntil(
      ($) => $.count('[data-testid="search-group-upcoming"] [data-testid="search-title"]') === 1,
    );
    expect(await titles('upcoming')).toEqual(['Harbour walk']);
    expect(
      await cdp.evaluate(
        // Newest first.
        ($) => $.el('[data-testid="search-turn-summary"]')!.textContent,
      ),
    ).toContain('with anna');

    // Clear, then plain words: Enter opens the top result.
    await cdp.clickTestId('search-clear');
    await cdp.waitUntil(
      ($) => $.has('[data-testid="search-hint"]') && $.count('[data-testid="search-turn"]') === 0,
    );
    await typeOver('harbour');
    expect(await cdp.evaluate(($, input: string) => $.el(input)!.dataset.routes, INPUT)).toBe(
      'open',
    );
    await cdp.waitUntil(settled);
    await cdp.evaluate(enter, INPUT);
    await cdp.waitUntil(($) => $.el('[data-testid="panel"]')?.dataset.panelKind === 'inspector');
    await cdp.pressEscape();
    await cdp.waitUntil(($) => $.el('[data-testid="panel"]')?.dataset.panelKind === 'search');
  });

  it('adds a filter by hand: tasks only, then a calendar, each a chip with ×', async () => {
    const { cdp } = app;
    await typeOver('harbour');
    await cdp.clickTestId('search-add-filter');
    await cdp.clickTestId('search-add-kind');
    await cdp.clickTestId('search-filter-kind-task');
    await cdp.pressEscape();
    await cdp.waitUntil(($) => $.has('[data-testid="search-chip-kind"]'));
    await cdp.waitUntil(
      ($) =>
        $.el('[data-testid="search-results"]')?.getAttribute('aria-busy') === 'false' &&
        !$.has('[data-testid="search-group-upcoming"]'),
    );
    expect(await titles('tasks')).toEqual(['Harbour checklist', 'Harbour fish']);
    // A chip edit is the user's own: no turn.
    expect(await cdp.evaluate(turns)).toBe(0);

    await cdp.evaluate(($) =>
      $.el('[data-testid="search-chip-kind"]')!
        .parentElement!.querySelector<HTMLElement>('[data-testid="search-chip-remove"]')!
        .click(),
    );
    await cdp.clickTestId('search-add-filter');
    await cdp.clickTestId('search-add-calendar');
    await cdp.clickTestId('search-filter-calendar-acc-e2e:cal-family');
    await cdp.pressEscape();
    await cdp.waitUntil(($) => $.has('[data-testid="search-chip-calendar-acc-e2e:cal-family"]'));
    await cdp.waitUntil(settled);
    await cdp.waitUntil(
      ($) => $.count('[data-testid="search-group-upcoming"] [data-testid="search-title"]') === 1,
    );
    expect(await titles('upcoming')).toEqual(['Harbour walk']);
    expect(await cdp.evaluate(($) => $.has('[data-testid="search-group-tasks"]'))).toBe(false);
    await cdp.clickTestId('search-clear');
    await cdp.waitUntil(($) => $.has('[data-testid="search-hint"]'));
  });

  it('edits the dates by hand in the chip’s popover', async () => {
    const { cdp } = app;
    await typeOver('harbour');
    await cdp.clickTestId('search-add-filter');
    await cdp.clickTestId('search-add-dates');
    const setDate = (testId: string, value: string) =>
      cdp.evaluate(
        ($, id: string, date: string) => $.setValue(`[data-testid="${id}"]`, date),
        testId,
        value,
      );
    // Picking When focuses From, as Place and People focus their field.
    const focused = () =>
      document.activeElement?.closest('[role="dialog"]')
        ? (document.activeElement as HTMLElement).dataset.testid
        : 'outside';
    await cdp.waitUntil(
      () =>
        (document.activeElement?.closest('[role="dialog"]')
          ? (document.activeElement as HTMLElement).dataset.testid
          : 'outside') === 'search-filter-from',
    );
    await setDate('search-filter-from', utcDay(1));
    await cdp.waitUntil(($) => $.has('[data-testid="search-chip-dates"]'));
    await setDate('search-filter-to', utcDay(2));

    // Tab steps through each date field's segments as Chromium does, and
    // wraps from To's last one to From — never out to the page behind.
    const press = async (shift: boolean) => {
      const seen: Array<string | undefined> = [];
      for (let count = 0; count < 16; count += 1) {
        await cdp.pressTab(shift);
        seen.push(await cdp.evaluate(focused));
      }
      expect(
        seen.filter((field) => field !== 'search-filter-from' && field !== 'search-filter-to'),
      ).toEqual([]);
      // How many presses in a row each field kept, the partial first and last runs left out.
      const runs: Array<{ field: string | undefined; length: number }> = [];
      for (const field of seen) {
        if (runs.at(-1)?.field === field) {
          runs.at(-1)!.length += 1;
        } else {
          runs.push({ field, length: 1 });
        }
      }
      return runs.slice(1, -1);
    };
    const forward = await press(false);
    // Month, day, year, and the picker button: the same count in each field.
    expect(forward.length).toBeGreaterThanOrEqual(2);
    const stops = forward[0]!.length;
    expect(stops).toBeGreaterThanOrEqual(3);
    expect(forward.map((run) => run.length)).toEqual(forward.map(() => stops));
    // Back through From's segments too. Shift+Tab wraps onto To's first
    // segment, not its last (script focus cannot pick one), so To's runs
    // are short.
    const backFrom = (await press(true)).filter((run) => run.field === 'search-filter-from');
    expect(backFrom.length).toBeGreaterThanOrEqual(1);
    expect(backFrom.map((run) => run.length)).toEqual(backFrom.map(() => stops));

    await cdp.pressEscape();
    await cdp.waitUntil(settled);
    // Focus is back on "+ Filter", which opened the popover.
    expect(
      await cdp.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid),
    ).toBe('search-add-filter');
    // Tomorrow's standup and the day after's planning; the tasks due on those days.
    await cdp.waitUntil(
      ($) => $.count('[data-testid="search-group-upcoming"] [data-testid="search-title"]') === 2,
    );
    expect(await titles('upcoming')).toEqual(['Harbour standup', 'Harbour planning']);
    expect(await titles('tasks')).toEqual(['Harbour checklist', 'Harbour fish']);
    expect(
      await cdp.evaluate(($) => $.el('[data-testid="search-chip-dates"]')!.textContent),
    ).toContain('–');
  });
});
