import { Account, APPLE_REMINDERS_ACCOUNT_ID, CalendarInfo, TaskListInfo } from '@calendar/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readEvents, readTasks } from './harness.ts';

// The draft thread: a phrase to the editor's Assistant makes drafts the grid
// draws hatched, every later phrase changes them, Undo shows the step
// before (kept with "Use this"), Save writes. The form is the same draft's
// other view: mounted behind the Assistant, so its fields are read here
// wherever the draft is, and brought forward (`showEditorView`) before one
// is clicked. The model is the deterministic fixture, so phrases are in its grammar —
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
// The conversation: what was said, a row per step not on show, the card of the one that is.
const said = `document.querySelectorAll('[data-testid="assistant-said"]').length`;
const versions = `document.querySelectorAll('[data-testid="assistant-version"]').length`;
const card = (part: string) =>
  `(document.querySelector('[data-testid="assistant-card-${part}"]')?.textContent ?? '')`;
const changed = `(document.querySelector('[data-testid="assistant-changed"]')?.textContent ?? '')`;
const stepPosition = `(document.querySelector('[data-testid="step-position"]')?.textContent ?? '')`;
const saveIsOff = `[...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Save')?.disabled === true`;
const marked = (selector: string) =>
  `(document.querySelector(${JSON.stringify(selector)})?.dataset.marked === '')`;
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
const disabled = (testId: string) =>
  `document.querySelector('[data-testid="${testId}"]')?.disabled === true`;
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
    await cdp.say('Dinner | +2 | 19:00-20:00');
    // The draft is on the grid, hatched and outlined; the answer is its
    // card, and the form behind holds it.
    await cdp.waitFor(blockAt('19:00'));
    expect(await cdp.eval<number>(blocks)).toBe(1);
    await cdp.waitFor(`${card('title')} === 'Dinner'`);
    expect(await cdp.eval<boolean>(titleIs('Dinner'))).toBe(true);
    expect(await cdp.eval<number>(said)).toBe(1);
    expect(await cdp.eval<string>(stepPosition)).toBe('1 of 1');
    // The step that made the draft changed nothing of it.
    expect(await cdp.eval<string>(changed)).toBe('');
    // The field is free for the next phrase.
    expect(await cdp.eval<string>(`document.querySelector(${JSON.stringify(INPUT)}).value`)).toBe(
      '',
    );

    // A change: the same field, the block moves, the form follows, and
    // the card marks the time with the old one beside it.
    await cdp.say('| | 20:00-21:00');
    await cdp.waitFor(blockAt('20:00'));
    expect(await cdp.eval<number>(blocks)).toBe(1);
    await cdp.waitFor(`document.querySelector(${JSON.stringify(START)})?.value === '20:00'`);
    await cdp.waitFor(`${stepPosition} === '2 of 2'`);
    expect(await cdp.eval<number>(said)).toBe(2);
    // The first step is a row above, with the way back to it.
    expect(await cdp.eval<number>(versions)).toBe(1);
    expect(await cdp.eval<string>(card('time'))).toBe('20:00–21:0019:00–20:00');
    expect(await cdp.eval<string>(changed)).toBe('Changed: time');

    // Undo shows the step before: the block and the form are back, and
    // nothing is written while it is only looked at.
    await cdp.clickTestId('assistant-undo');
    await cdp.waitFor(blockAt('19:00'));
    await cdp.waitFor(`document.querySelector(${JSON.stringify(START)})?.value === '19:00'`);
    expect(await cdp.eval<string>(stepPosition)).toBe('1 of 2');
    expect(await cdp.eval<boolean>(saveIsOff)).toBe(true);
    // "Use this" keeps it and lets the later step go.
    await cdp.clickTestId('step-use');
    await cdp.waitFor(`${stepPosition} === '1 of 1'`);
    expect(await cdp.eval<number>(said)).toBe(1);
    expect(await cdp.eval<boolean>(blockAt('19:00'))).toBe(true);

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

  it("takes the spoken command off a dictated phrase's title", async () => {
    const { cdp } = app;
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(headingIs('New event'));
    // A sentence, not the fixture's grammar: the fixture answers it whole
    // as the title, as the iPhone's model did (2026-11-06), and the
    // normalizer reads the when off it and the command around it.
    await cdp.say('Add an event to have lunch with Stefan tomorrow at 1');
    await cdp.waitFor(blockAt('13:00'));
    await cdp.waitFor(titleIs('Lunch with Stefan'));
    expect(await cdp.eval<string>(card('title'))).toBe('Lunch with Stefan');
  });

  it('reads a note and a notification from the phrase into the form; a turn about nothing else needs no model', async () => {
    const { cdp } = app;
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(headingIs('New event'));
    // The clauses leave the phrase before the (fixture) model sees it: the grammar still parses.
    await cdp.say('Dentist | +2 | 10:00-11:00, remind me 30 minutes before, note: bring the card');
    await cdp.waitFor(blockAt('10:00'));
    expect(await cdp.eval<boolean>(titleIs('Dentist'))).toBe(true);
    await cdp.waitFor(`${valueOf('[data-testid="editor-notes"]')} === 'bring the card'`);
    expect(await cdp.eval<string>(valueOf('[data-testid="event-reminder-0"]'))).toBe('30');
    // The card lists both.
    expect(await cdp.eval<string>(card('reminders'))).toBe('30 minutes before');
    expect(await cdp.eval<string>(card('notes'))).toBe('bring the card');

    // Words about a notification alone: no model call, the row joins and is the one marked.
    await cdp.say('and an hour before as well');
    await cdp.waitFor(`${valueOf('[data-testid="event-reminder-1"]')} === '60'`);
    expect(await cdp.eval<string>(valueOf('[data-testid="event-reminder-0"]'))).toBe('30');
    await cdp.waitFor(`${changed} === 'Changed: notifications'`);
    await cdp.waitFor(marked('[data-testid="event-reminders"]'));
    expect(await cdp.eval<boolean>(marked('[data-testid="editor-notes"]'))).toBe(false);
    // A note added by a step joins the notes on a line of its own.
    await cdp.say('add a note: ask about the fee');
    await cdp.waitFor(
      `${valueOf('[data-testid="editor-notes"]')} === 'bring the card\\nask about the fee'`,
    );
    expect(await cdp.eval<string>(valueOf('[data-testid="event-reminder-1"]'))).toBe('60');
    await cdp.waitFor(marked('[data-testid="editor-notes"]'));
    expect(await cdp.eval<boolean>(marked('[data-testid="event-reminders"]'))).toBe(false);
    // Undo, kept: the note is back, the notifications with it untouched.
    await cdp.clickTestId('assistant-undo');
    await cdp.waitFor(`${valueOf('[data-testid="editor-notes"]')} === 'bring the card'`);
    await cdp.clickTestId('step-use');
    await cdp.waitFor(`${stepPosition} === '2 of 2'`);
    expect(await cdp.eval<string>(valueOf('[data-testid="editor-notes"]'))).toBe('bring the card');
    expect(await cdp.eval<string>(valueOf('[data-testid="event-reminder-1"]'))).toBe('60');
  });

  it('lists every step in the conversation, the newest as a card, and marks what it changed in the form', async () => {
    const { cdp } = app;
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(
      `document.querySelector('[data-testid="editor-title"]')?.textContent === 'New event'`,
    );
    await cdp.say('Gym | +3 | 07:00-08:00');
    await cdp.waitFor(blockAt('07:00'));
    for (const [start, end] of [
      ['08:00', '09:00'],
      ['09:00', '10:00'],
      ['10:00', '11:00'],
    ] as const) {
      await cdp.say(`| | ${start}-${end}`);
      await cdp.waitFor(blockAt(start));
    }
    // One phrase, one step: four said, three rows and the card of the fourth.
    await cdp.waitFor(`${stepPosition} === '4 of 4'`);
    expect(await cdp.eval<number>(said)).toBe(4);
    expect(await cdp.eval<number>(versions)).toBe(3);
    expect(await cdp.eval<string>(card('time'))).toBe('10:00–11:0009:00–10:00');
    // The first row is the step that made it.
    expect(
      await cdp.eval<string>(
        `document.querySelector('[data-testid="assistant-version"]').textContent`,
      ),
    ).toContain('Gym');
    // The form marks the times the last step moved, and stays marked; the title it left alone.
    await cdp.showEditorView('form');
    expect(await cdp.eval<boolean>(marked(START))).toBe(true);
    expect(await cdp.eval<boolean>(marked(TITLE))).toBe(false);
    // An edit by hand is a step too, and the newest: nothing is marked under the hand.
    await cdp.type(TITLE, ' (legs)');
    await cdp.waitFor(`${stepPosition} === '5 of 5'`);
    await cdp.waitFor(`!${marked(START)}`);
    // Back in the conversation it is a row's worth: the card of version 5, by hand.
    await cdp.showEditorView('assistant');
    expect(await cdp.eval<number>(versions)).toBe(4);
    expect(await cdp.eval<string>(card('title'))).toContain('(legs)');
  });

  it('opens a pasted mail as one thread of drafts: the pager and the blocks switch the form, Remove drops one, Add all writes the rest', async () => {
    const { cdp } = app;
    // All on today: a block is clicked on the grid, and a draft a day on
    // sits in next week on a Sunday, off the week on view.
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
    // The conversation: the focused draft as a card, the others a line each.
    expect(await cdp.eval<string>(card('title'))).toBe('Standup');
    expect(
      await cdp.eval<number>(`document.querySelectorAll('[data-testid="assistant-draft"]').length`),
    ).toBe(2);

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
    // By hand from here: the form, with the pager above it as above the conversation.
    await cdp.showEditorView('form');

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

  it('keeps the drafts where they are while a kind switch asks its question', async () => {
    const { cdp } = app;
    await cdp.eval(
      paste(['Dinner | +0 | 19:00-20:00 | Room 4', 'Retro | +1 | 16:00-17:00'].join('\n')),
    );
    await cdp.waitFor(`${position} === '1 of 2'`);
    await cdp.waitFor(titleIs('Dinner'));
    await cdp.showEditorView('form');
    // A to-do has no place: the switch asks before it lets go of one.
    await cdp.clickTestId('mode-task');
    await cdp.waitFor(asked);
    // The answer is this draft's. Until it is given the form is between
    // two kinds, and the pager and Remove wait: moved on, the answer would
    // land on the draft focused by then.
    expect(await cdp.eval<boolean>(disabled('draft-next'))).toBe(true);
    expect(await cdp.eval<boolean>(disabled('draft-remove'))).toBe(true);
    await cdp.clickTestId('move-confirm-yes');
    await cdp.waitFor(headingIs('New task'));
    expect(await cdp.eval<boolean>(titleIs('Dinner'))).toBe(true);
    expect(await cdp.eval<string>(position)).toBe('1 of 2');
    // The other draft is as it came.
    await cdp.waitFor(`!(${disabled('draft-next')})`);
    await cdp.clickTestId('draft-next');
    await cdp.waitFor(titleIs('Retro'));
    await cdp.waitFor(headingIs('New event'));
  });
});
