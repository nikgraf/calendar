import { Account, CalendarInfo, EventRecord, TaskListInfo, TaskRecord } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp } from './harness.ts';

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
const SETTLED = `document.querySelector('[data-testid="search-results"]')?.getAttribute('aria-busy') === 'false'`;
const PANEL_KIND = `document.querySelector('[data-testid="panel"]')?.dataset.panelKind`;
const turns = `document.querySelectorAll('[data-testid="search-turn"]').length`;
const has = (testId: string) => `!!document.querySelector('[data-testid="${testId}"]')`;
const fieldIs = (text: string) =>
  `document.querySelector(${JSON.stringify(INPUT)})?.value === ${JSON.stringify(text)}`;
const enter = `document.querySelector(${JSON.stringify(INPUT)}).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))`;

describe('Search filters', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { env: { TZ: 'UTC' }, model: 'fixture' });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  const titles = (group: 'past' | 'tasks' | 'upcoming') =>
    app.cdp.eval<Array<string>>(
      `[...document.querySelectorAll('[data-testid="search-group-${group}"] [data-testid="search-title"]')].map((title) => title.textContent)`,
    );

  /** Types over the field; waits for the words to be in it. */
  const typeOver = async (text: string) => {
    const { cdp } = app;
    await cdp.eval(`document.querySelector(${JSON.stringify(INPUT)}).select()`);
    await cdp.type(INPUT, text);
    await cdp.waitFor(fieldIs(text));
  };

  it('reads a sentence into a date chip, leaves its words in the field, and takes it back on Undo', async () => {
    const { cdp } = app;
    await cdp.eval(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }))`,
    );
    await cdp.waitFor(has('search-input'));
    await typeOver('harbour | -15..-5');
    await cdp.clickTestId('search-ask');
    await cdp.waitFor(`${turns} === 1`);
    await cdp.waitFor(fieldIs('harbour'));
    await cdp.waitFor(has('search-chip-dates'));
    await cdp.waitFor(SETTLED);
    // A week ago's standup and the retro; nothing ahead, no task due in the range.
    await cdp.waitFor(`!${has('search-group-upcoming')} && ${has('search-group-past')}`);
    expect(await titles('past')).toEqual(['Harbour standup', 'Harbour retro']);
    expect(await cdp.eval<boolean>(has('search-group-tasks'))).toBe(false);

    await cdp.clickTestId('search-undo');
    await cdp.waitFor(`${turns} === 0`);
    await cdp.waitFor(fieldIs('harbour | -15..-5'));
    expect(await cdp.eval<boolean>(has('search-chip-dates'))).toBe(false);
  });

  it('routes Enter by the words: a filter is read, plain words open the top result', async () => {
    const { cdp } = app;
    await typeOver('harbour | | hafen');
    expect(
      await cdp.eval<string>(`document.querySelector(${JSON.stringify(INPUT)}).dataset.routes`),
    ).toBe('ask');
    await cdp.eval(enter);
    await cdp.waitFor(has('search-chip-location'));
    expect(
      await cdp.eval<string>(
        `document.querySelector('[data-testid="search-chip-location"]').textContent`,
      ),
    ).toBe('in hafen');
    await cdp.waitFor(SETTLED);
    await cdp.waitFor(`${has('search-group-upcoming')}`);
    expect(await titles('upcoming')).toEqual(['Harbour planning']);
    // A place leaves tasks out.
    expect(await cdp.eval<boolean>(has('search-group-tasks'))).toBe(false);

    // × takes the chip away; a person, read the same way.
    await cdp.eval(
      `document.querySelector('[data-testid="search-chip-location"]').parentElement.querySelector('[data-testid="search-chip-remove"]').click()`,
    );
    await cdp.waitFor(`!${has('search-chip-location')}`);
    await typeOver('harbour | | | anna');
    await cdp.eval(enter);
    await cdp.waitFor(has('search-chip-people'));
    await cdp.waitFor(SETTLED);
    await cdp.waitFor(
      `document.querySelectorAll('[data-testid="search-group-upcoming"] [data-testid="search-title"]').length === 1`,
    );
    expect(await titles('upcoming')).toEqual(['Harbour walk']);
    expect(
      await cdp.eval<string>(
        // Newest first.
        `document.querySelector('[data-testid="search-turn-summary"]').textContent`,
      ),
    ).toContain('with anna');

    // Clear, then plain words: Enter opens the top result.
    await cdp.clickTestId('search-clear');
    await cdp.waitFor(`${has('search-hint')} && ${turns} === 0`);
    await typeOver('harbour');
    expect(
      await cdp.eval<string>(`document.querySelector(${JSON.stringify(INPUT)}).dataset.routes`),
    ).toBe('open');
    await cdp.waitFor(SETTLED);
    await cdp.eval(enter);
    await cdp.waitFor(`${PANEL_KIND} === 'inspector'`);
    await cdp.pressEscape();
    await cdp.waitFor(`${PANEL_KIND} === 'search'`);
  });

  it('adds a filter by hand: tasks only, then a calendar, each a chip with ×', async () => {
    const { cdp } = app;
    await typeOver('harbour');
    await cdp.clickTestId('search-add-filter');
    await cdp.clickTestId('search-add-kind');
    await cdp.clickTestId('search-filter-kind-task');
    await cdp.pressEscape();
    await cdp.waitFor(has('search-chip-kind'));
    await cdp.waitFor(`${SETTLED} && !${has('search-group-upcoming')}`);
    expect(await titles('tasks')).toEqual(['Harbour checklist', 'Harbour fish']);
    // A chip edit is the user's own: no turn.
    expect(await cdp.eval<number>(turns)).toBe(0);

    await cdp.eval(
      `document.querySelector('[data-testid="search-chip-kind"]').parentElement.querySelector('[data-testid="search-chip-remove"]').click()`,
    );
    await cdp.clickTestId('search-add-filter');
    await cdp.clickTestId('search-add-calendar');
    await cdp.clickTestId('search-filter-calendar-acc-e2e:cal-family');
    await cdp.pressEscape();
    await cdp.waitFor(has('search-chip-calendar-acc-e2e:cal-family'));
    await cdp.waitFor(SETTLED);
    await cdp.waitFor(
      `document.querySelectorAll('[data-testid="search-group-upcoming"] [data-testid="search-title"]').length === 1`,
    );
    expect(await titles('upcoming')).toEqual(['Harbour walk']);
    expect(await cdp.eval<boolean>(has('search-group-tasks'))).toBe(false);
    await cdp.clickTestId('search-clear');
    await cdp.waitFor(has('search-hint'));
  });

  it('edits the dates by hand in the chip’s popover', async () => {
    const { cdp } = app;
    await typeOver('harbour');
    await cdp.clickTestId('search-add-filter');
    await cdp.clickTestId('search-add-dates');
    const setDate = (testId: string, value: string) =>
      cdp.eval(`(() => {
        const input = document.querySelector('[data-testid="${testId}"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
    await setDate('search-filter-from', utcDay(1));
    await cdp.waitFor(has('search-chip-dates'));
    await setDate('search-filter-to', utcDay(2));
    await cdp.pressEscape();
    await cdp.waitFor(SETTLED);
    // Tomorrow's standup and the day after's planning; the tasks due on those days.
    await cdp.waitFor(
      `document.querySelectorAll('[data-testid="search-group-upcoming"] [data-testid="search-title"]').length === 2`,
    );
    expect(await titles('upcoming')).toEqual(['Harbour standup', 'Harbour planning']);
    expect(await titles('tasks')).toEqual(['Harbour checklist', 'Harbour fish']);
    expect(
      await cdp.eval<string>(
        `document.querySelector('[data-testid="search-chip-dates"]').textContent`,
      ),
    ).toContain('–');
  });
});
