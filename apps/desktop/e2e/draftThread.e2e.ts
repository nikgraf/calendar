import { Account, APPLE_REMINDERS_ACCOUNT_ID, CalendarInfo, TaskListInfo } from '@calendar/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readEvents, readTasks } from './harness.ts';

// The draft thread: a phrase makes drafts the grid draws hatched, every
// later phrase changes them, Undo takes a turn back, Save writes. The model
// is the deterministic fixture, so phrases are in its grammar —
// `Title | +N | HH:MM-HH:MM | Location`, empty parts in a change meaning
// "unchanged" — and nothing here depends on the date or on Apple
// Intelligence. Two calendars (Work sorts first: the default), a Google
// task list and a Reminders list (the fixture's), so drafts can go to
// different places as different kinds.
const WORK = '#3b82f6';
const YOGA = '#16a34a';
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
  calendars: [
    new CalendarInfo({
      accessRole: 'owner',
      accountId: 'acc-e2e',
      colorHex: WORK,
      id: 'cal-e2e',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'Work',
      timeZone: 'Europe/Vienna',
    }),
    new CalendarInfo({
      accessRole: 'owner',
      accountId: 'acc-e2e',
      colorHex: YOGA,
      id: 'cal-yoga',
      isPrimary: false,
      isVisible: true,
      provider: 'google',
      summary: 'Yoga',
      timeZone: 'Europe/Vienna',
    }),
  ],
  events: [],
  taskLists: [
    new TaskListInfo({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      colorHex: '#ff9500',
      id: 'ek-groceries',
      isVisible: true,
      provider: 'apple',
      title: 'Groceries',
    }),
    new TaskListInfo({
      accountId: 'acc-e2e',
      id: 'list-errands',
      isVisible: true,
      provider: 'google',
      title: 'Errands',
    }),
  ],
};
const reminders = {
  fixture: {
    lists: [
      { allowsModifications: true, colorHex: '#ff9500', id: 'ek-groceries', title: 'Groceries' },
    ],
  },
};

const INPUT = '[data-testid="quick-add-input"]';
const TITLE = 'input[placeholder="Title"]';
const START = 'input[aria-label="Start time"]';
// CDP key events don't carry macOS meta reliably: dispatch ⌘N to the app's own window listener.
const COMMAND_N = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }))`;
const blocks = `document.querySelectorAll('[data-testid="draft-block"]').length`;
const blockAt = (start: string) =>
  `!!document.querySelector('[data-testid="draft-block"][data-draft-start="${start}"]')`;
const turns = `document.querySelectorAll('[data-testid="draft-turn"]').length`;
// The list runs newest first: the first summary is the last turn's.
const newestSummary = `document.querySelector('[data-testid="draft-turn-summary"]')?.textContent ?? ''`;
const position = `(document.querySelector('[data-testid="draft-position"]')?.textContent ?? '')`;
const titleIs = (title: string) =>
  `document.querySelector(${JSON.stringify(TITLE)})?.value === ${JSON.stringify(title)}`;
const headingIs = (text: string) =>
  `document.querySelector('[data-testid="editor-title"]')?.textContent === ${JSON.stringify(text)}`;
const valueOf = (selector: string) =>
  `document.querySelector(${JSON.stringify(selector)})?.value ?? ''`;
const CALENDAR = 'select[aria-label="Calendar"]';
const LIST = 'select[aria-label="Task list"]';
const setSelect = (selector: string, value: string) => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(element, ${JSON.stringify(value)});
  element.dispatchEvent(new Event('change', { bubbles: true }));
})()`;
const PRIORITY = `document.querySelector('[aria-label="Priority"] [role="radio"][aria-checked="true"]')?.textContent ?? ''`;
const pickPriority = (label: string) =>
  `[...document.querySelectorAll('[aria-label="Priority"] [role="radio"]')].find((option) => option.textContent === ${JSON.stringify(label)}).click()`;
const asked = `!!document.querySelector('[data-testid="move-confirm"]')`;
const colorAt = (start: string) =>
  `document.querySelector('[data-testid="draft-block"][data-draft-start="${start}"]')?.dataset.color ?? ''`;

/** A paste as the OS would deliver it, on the window: the text as text/plain. */
const paste = (text: string) => `(() => {
  const data = new DataTransfer();
  data.setData('text/plain', ${JSON.stringify(text)});
  window.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
})()`;

describe('The draft thread', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { model: 'fixture', reminders });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });
  afterEach(async () => {
    // A failure above must not strand an editor for the next test.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await app.cdp.eval<boolean>(`!!document.querySelector('[data-testid="editor"]')`))) {
        return;
      }
      await app.cdp.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  });

  it('draws a phrase as a draft, moves it on a second phrase, takes it back on Undo, and writes it on Save', async () => {
    const { cdp } = app;
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(
      `document.querySelector('[data-testid="editor-title"]')?.textContent === 'New event'`,
    );
    await cdp.type(INPUT, 'Dinner | +2 | 19:00-20:00');
    await cdp.clickTestId('quick-add-apply');
    // The draft is on the grid, hatched and outlined, and the form holds it.
    await cdp.waitFor(blockAt('19:00'));
    expect(await cdp.eval<number>(blocks)).toBe(1);
    expect(await cdp.eval<boolean>(titleIs('Dinner'))).toBe(true);
    expect(await cdp.eval<number>(turns)).toBe(1);
    // The field is free for the next phrase.
    expect(await cdp.eval<string>(`document.querySelector(${JSON.stringify(INPUT)}).value`)).toBe(
      '',
    );

    // A change: the same field, the block moves, the form follows, a turn is listed.
    await cdp.type(INPUT, '| | 20:00-21:00');
    await cdp.clickTestId('quick-add-apply');
    await cdp.waitFor(blockAt('20:00'));
    expect(await cdp.eval<number>(blocks)).toBe(1);
    await cdp.waitFor(`document.querySelector(${JSON.stringify(START)})?.value === '20:00'`);
    expect(await cdp.eval<number>(turns)).toBe(2);
    // The newest turn on top, with the Undo.
    expect(await cdp.eval<string>(newestSummary)).toContain('20:00–21:00');
    expect(
      await cdp.eval<boolean>(
        `!!document.querySelector('[data-testid="draft-turn"] [data-testid="draft-undo"]')`,
      ),
    ).toBe(true);

    // Undo: the turn is gone, the block and the form are back.
    await cdp.clickTestId('draft-undo');
    await cdp.waitFor(blockAt('19:00'));
    await cdp.waitFor(`document.querySelector(${JSON.stringify(START)})?.value === '19:00'`);
    expect(await cdp.eval<number>(turns)).toBe(1);

    // Save writes the draft; no draft is left on the grid, the event is.
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`${blocks} === 0`);
    await expect
      .poll(async () =>
        (await readEvents(app.userDataDir)).find((event) => event.title === 'Dinner'),
      )
      .toMatchObject({ calendarId: 'cal-e2e', isAllDay: false });
    await cdp.locate('[title^="Dinner ·"]');
  });

  it('lists the turns newest first, two until "+2 earlier queries" opens the rest, and flashes the field a turn changed', async () => {
    const { cdp } = app;
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(
      `document.querySelector('[data-testid="editor-title"]')?.textContent === 'New event'`,
    );
    await cdp.type(INPUT, 'Gym | +3 | 07:00-08:00');
    await cdp.clickTestId('quick-add-apply');
    await cdp.waitFor(blockAt('07:00'));
    for (const [start, end] of [
      ['08:00', '09:00'],
      ['09:00', '10:00'],
      ['10:00', '11:00'],
    ] as const) {
      await cdp.type(INPUT, `| | ${start}-${end}`);
      await cdp.clickTestId('quick-add-apply');
      await cdp.waitFor(blockAt(start));
    }
    // The start time the last turn moved tints and fades back.
    await cdp.waitFor(
      `document.querySelector(${JSON.stringify(START)})?.getAnimations().length === 1`,
    );
    expect(await cdp.eval<number>(turns)).toBe(2);
    expect(await cdp.eval<string>(newestSummary)).toContain('10:00–11:00');
    const more = `document.querySelector('[data-testid="draft-turns-more"]')?.textContent ?? ''`;
    expect(await cdp.eval<string>(more)).toBe('+2 earlier queries');
    await cdp.clickTestId('draft-turns-more');
    await cdp.waitFor(`${turns} === 4`);
    expect(
      await cdp.eval<string>(
        `[...document.querySelectorAll('[data-testid="draft-turn-summary"]')].at(-1).textContent`,
      ),
    ).toContain('Gym');
    await cdp.clickTestId('draft-turns-less');
    await cdp.waitFor(`${turns} === 2`);
  });

  it('opens a pasted mail as one thread of drafts: the pager and the blocks switch the form, Remove drops one, Add all writes the rest', async () => {
    const { cdp } = app;
    await cdp.eval(
      paste(
        [
          // All on today, so every block is on the grid together whatever the
          // weekday: on the week's last day "+1" is next week's first.
          'Standup | +0 | 09:00-09:30 | Room 4',
          'Planning | +0 | 14:00-15:00',
          'Review | +0 | 16:00-17:00',
        ].join('\n'),
      ),
    );
    await cdp.waitFor(`${position} === '1 of 3'`);
    await cdp.waitFor(`${blocks} === 3`);
    expect(await cdp.eval<boolean>(titleIs('Standup'))).toBe(true);

    // A click on another draft's block focuses it.
    const planning = await cdp.locate('[data-testid="draft-block"][data-draft-start="14:00"]');
    await cdp.click(planning.x, planning.y);
    await cdp.waitFor(`${position} === '2 of 3'`);
    await cdp.waitFor(titleIs('Planning'));
    expect(
      await cdp.eval<boolean>(
        `!!document.querySelector('[data-testid="draft-block"][data-draft-start="14:00"][data-focused]')`,
      ),
    ).toBe(true);

    // The pager: next, then Remove drops the third.
    await cdp.clickTestId('draft-next');
    await cdp.waitFor(`${position} === '3 of 3'`);
    await cdp.waitFor(titleIs('Review'));
    await cdp.clickTestId('draft-remove');
    await cdp.waitFor(`${position} === '2 of 2'`);
    await cdp.waitFor(`${blocks} === 2`);
    await cdp.waitFor(titleIs('Planning'));

    // Add all: both written, the editor closed, no draft left.
    await cdp.clickTestId('draft-add-all');
    await cdp.waitFor(`!document.querySelector('[data-testid="editor"]')`);
    await cdp.waitFor(`${blocks} === 0`);
    await expect
      .poll(async () => {
        const events = await readEvents(app.userDataDir);
        return ['Standup', 'Planning', 'Review'].map((title) =>
          events.some((event) => event.title === title),
        );
      })
      .toEqual([true, true, false]);
    expect(
      (await readEvents(app.userDataDir)).find((event) => event.title === 'Standup'),
    ).toMatchObject({ location: 'Room 4' });
  });

  it('keeps the kind, calendar or list picked for each draft, and Add all writes events and to-dos alike', async () => {
    const { cdp } = app;
    // The drafts come in date order, all-day first: Breakfast, Post office, Buy milk, Retro.
    await cdp.eval(
      paste(
        [
          'Breakfast | +0 | 08:00-08:30',
          'Buy milk | +1 | 07:00-07:30',
          'Post office | +1',
          'Retro | +1 | 16:00-17:00',
        ].join('\n'),
      ),
    );
    await cdp.waitFor(`${position} === '1 of 4'`);
    await cdp.waitFor(titleIs('Breakfast'));

    // The first goes to Yoga: its block takes the color.
    await cdp.eval(setSelect(CALENDAR, 'acc-e2e:cal-yoga'));
    await cdp.waitFor(`${colorAt('08:00')} === ${JSON.stringify(YOGA)}`);

    // The second becomes a task on the Google list.
    await cdp.clickTestId('draft-next');
    await cdp.waitFor(titleIs('Post office'));
    await cdp.clickTestId('mode-task');
    await cdp.waitFor(headingIs('New task'));
    expect(await cdp.eval<string>(valueOf(LIST))).toBe('acc-e2e:list-errands');

    // The third shows as the event it is — not a task, nothing asked —
    // and becomes a high-priority reminder.
    await cdp.clickTestId('draft-next');
    await cdp.waitFor(titleIs('Buy milk'));
    expect(await cdp.eval<boolean>(headingIs('New event'))).toBe(true);
    expect(await cdp.eval<boolean>(asked)).toBe(false);
    await cdp.clickTestId('mode-reminder');
    await cdp.waitFor(headingIs('New reminder'));
    await cdp.eval(pickPriority('High'));
    await cdp.waitFor(`${PRIORITY} === 'High'`);

    // The fourth, never shown, starts in the calendar the form has (Yoga); it goes to Work.
    await cdp.clickTestId('draft-next');
    await cdp.waitFor(titleIs('Retro'));
    await cdp.waitFor(headingIs('New event'));
    expect(await cdp.eval<string>(valueOf(CALENDAR))).toBe('acc-e2e:cal-yoga');
    await cdp.eval(setSelect(CALENDAR, 'acc-e2e:cal-e2e'));

    // Back through them: each as it was left, and nothing asked.
    await cdp.clickTestId('draft-prev');
    await cdp.waitFor(titleIs('Buy milk'));
    await cdp.waitFor(headingIs('New reminder'));
    expect(await cdp.eval<string>(PRIORITY)).toBe('High');
    expect(await cdp.eval<string>(valueOf(LIST))).toBe(
      `${APPLE_REMINDERS_ACCOUNT_ID}:ek-groceries`,
    );
    await cdp.clickTestId('draft-prev');
    await cdp.waitFor(titleIs('Post office'));
    await cdp.waitFor(headingIs('New task'));
    expect(await cdp.eval<string>(valueOf(LIST))).toBe('acc-e2e:list-errands');
    await cdp.clickTestId('draft-prev');
    await cdp.waitFor(titleIs('Breakfast'));
    await cdp.waitFor(headingIs('New event'));
    expect(await cdp.eval<string>(valueOf(CALENDAR))).toBe('acc-e2e:cal-yoga');
    expect(await cdp.eval<boolean>(asked)).toBe(false);
    // Each event draft drawn in its own calendar's color.
    await cdp.waitFor(`${colorAt('16:00')} === ${JSON.stringify(WORK)}`);
    expect(await cdp.eval<string>(colorAt('08:00'))).toBe(YOGA);

    // Add all: every draft where it was put, as what it was made.
    await cdp.clickTestId('draft-add-all');
    await cdp.waitFor(`!document.querySelector('[data-testid="editor"]')`);
    await expect
      .poll(async () => {
        const events = await readEvents(app.userDataDir);
        return ['Breakfast', 'Retro'].map(
          (title) => events.find((event) => event.title === title)?.calendarId,
        );
      })
      .toEqual(['cal-yoga', 'cal-e2e']);
    await expect
      .poll(async () => {
        const tasks = await readTasks(app.userDataDir);
        const milk = tasks.find((task) => task.title === 'Buy milk');
        const post = tasks.find((task) => task.title === 'Post office');
        return {
          milk: [milk?.provider, milk?.listId, milk?.priority, milk?.dueTime],
          post: [post?.provider, post?.listId],
        };
      })
      .toEqual({
        milk: ['apple', 'ek-groceries', 'high', '07:00'],
        post: ['google', 'list-errands'],
      });
  });
});
