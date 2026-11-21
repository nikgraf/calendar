import { Account, APPLE_REMINDERS_ACCOUNT_ID, CalendarInfo, TaskListInfo } from '@calendar/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readDeviceSetting, readEvents, readTasks } from './harness.ts';
import type { PageKit } from './page.ts';

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
const commandN = () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }));
};
const blocks = ($: PageKit) => $.count('[data-testid="draft-block"]');
const blockAt = ($: PageKit, start: string) =>
  $.has(`[data-testid="draft-block"][data-draft-start="${start}"]`);
// The conversation: what was said, a row per step not on show, the card of the one that is.
const said = ($: PageKit) => $.count('[data-testid="assistant-said"]');
const versions = ($: PageKit) => $.count('[data-testid="assistant-version"]');
const card = ($: PageKit, part: string) => $.text(`[data-testid="assistant-card-${part}"]`);
const changed = ($: PageKit) => $.text('[data-testid="assistant-changed"]');
const stepPosition = ($: PageKit) => $.text('[data-testid="step-position"]');
const saveIsOff = ($: PageKit) => $.button('Save')?.disabled === true;
const marked = ($: PageKit, selector: string) => $.el(selector)?.dataset.marked === '';
const position = ($: PageKit) => $.text('[data-testid="draft-position"]');
const titleIs = ($: PageKit, title: string, want: string) => $.value(title) === want;
const headingIs = ($: PageKit, text: string) => $.text('[data-testid="editor-title"]') === text;
const valueOf = ($: PageKit, selector: string) => $.value(selector);
const CALENDAR = 'select[aria-label="Calendar"]';
const LIST = 'select[aria-label="Task list"]';
const setSelect = ($: PageKit, selector: string, value: string) => {
  const element = $.el<HTMLSelectElement>(selector)!;
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(
    element,
    value,
  );
  element.dispatchEvent(new Event('change', { bubbles: true }));
};
const priority = ($: PageKit) =>
  $.text('[aria-label="Priority"] [role="radio"][aria-checked="true"]');
const pickPriority = ($: PageKit, label: string) => {
  $.all('[aria-label="Priority"] [role="radio"]')
    .find((option) => option.textContent === label)!
    .click();
};
const asked = ($: PageKit) => $.has('[data-testid="move-confirm"]');
const ALERT = '[data-testid="reminder-alarm"]';
const NOTES = 'textarea[placeholder="Add notes"]';
const REPEAT = 'select[aria-label="Repeat"]';
const alertLabel = ($: PageKit, alert: string) => $.text(`${alert} option:checked`);
const disabled = ($: PageKit, testId: string) =>
  $.el<HTMLButtonElement>(`[data-testid="${testId}"]`)?.disabled === true;
const colorAt = ($: PageKit, start: string) =>
  $.el(`[data-testid="draft-block"][data-draft-start="${start}"]`)?.dataset.color ?? '';

/** A paste as the OS would deliver it, on the window: the text as text/plain. */
const paste = (_: PageKit, text: string) => {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  window.dispatchEvent(
    new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
  );
};

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
      if (!(await app.cdp.evaluate(($) => $.has('[data-testid="editor"]')))) {
        return;
      }
      await app.cdp.escapeOrDiscard();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  });

  it('draws a phrase as a draft, moves it on a second phrase, takes it back on Undo, and writes it on Save', async () => {
    const { cdp } = app;
    await cdp.evaluate(commandN);
    await cdp.waitUntil(($) => $.text('[data-testid="editor-title"]') === 'New event');
    await cdp.say('Dinner | +2 | 19:00-20:00');
    // The draft is on the grid, hatched and outlined; the answer is its
    // card, and the form behind holds it.
    await cdp.waitUntil(blockAt, '19:00');
    expect(await cdp.evaluate(blocks)).toBe(1);
    await cdp.waitUntil(($) => $.text('[data-testid="assistant-card-title"]') === 'Dinner');
    expect(await cdp.evaluate(titleIs, TITLE, 'Dinner')).toBe(true);
    expect(await cdp.evaluate(said)).toBe(1);
    expect(await cdp.evaluate(stepPosition)).toBe('1 of 1');
    // The step that made the draft changed nothing of it.
    expect(await cdp.evaluate(changed)).toBe('');
    // The field is free for the next phrase.
    expect(
      await cdp.evaluate(($, input: string) => $.el<HTMLInputElement>(input)!.value, INPUT),
    ).toBe('');

    // A change: the same field, the block moves, the form follows, and
    // the card marks the time with the old one beside it.
    await cdp.say('| | 20:00-21:00');
    await cdp.waitUntil(blockAt, '20:00');
    expect(await cdp.evaluate(blocks)).toBe(1);
    await cdp.waitUntil(($, start: string) => $.value(start) === '20:00', START);
    await cdp.waitUntil(($) => $.text('[data-testid="step-position"]') === '2 of 2');
    expect(await cdp.evaluate(said)).toBe(2);
    // The first step is a row above, with the way back to it.
    expect(await cdp.evaluate(versions)).toBe(1);
    expect(await cdp.evaluate(card, 'time')).toBe('20:00–21:0019:00–20:00');
    expect(await cdp.evaluate(changed)).toBe('Changed: time');

    // Undo shows the step before: the block and the form are back, and
    // nothing is written while it is only looked at.
    await cdp.clickTestId('assistant-undo');
    await cdp.waitUntil(blockAt, '19:00');
    await cdp.waitUntil(($, start: string) => $.value(start) === '19:00', START);
    expect(await cdp.evaluate(stepPosition)).toBe('1 of 2');
    expect(await cdp.evaluate(saveIsOff)).toBe(true);
    // "Use this" keeps it and lets the later step go.
    await cdp.clickTestId('step-use');
    await cdp.waitUntil(($) => $.text('[data-testid="step-position"]') === '1 of 1');
    expect(await cdp.evaluate(said)).toBe(1);
    expect(await cdp.evaluate(blockAt, '19:00')).toBe(true);

    // Save writes the draft; no draft is left on the grid, the event is.
    await cdp.clickButtonWithText('Save');
    await cdp.waitUntil(($) => $.count('[data-testid="draft-block"]') === 0);
    await expect
      .poll(async () =>
        (await readEvents(app.userDataDir)).find((event) => event.title === 'Dinner'),
      )
      .toMatchObject({ calendarId: 'cal-e2e', isAllDay: false });
    await cdp.locate('[title^="Dinner ·"]');
  });

  it('reads a note and a notification from the phrase into the form, and adds to them turn by turn', async () => {
    const { cdp } = app;
    await cdp.evaluate(commandN);
    await cdp.waitUntil(headingIs, 'New event');
    // The fixture's extras: the model answers the note and the notification with the event.
    await cdp.say('Dentist | +2 | 10:00-11:00 | | remind 30, note: bring the card');
    await cdp.waitUntil(blockAt, '10:00');
    expect(await cdp.evaluate(titleIs, TITLE, 'Dentist')).toBe(true);
    await cdp.waitUntil(($) => $.value('[data-testid="editor-notes"]') === 'bring the card');
    expect(await cdp.evaluate(valueOf, '[data-testid="event-reminder-0"]')).toBe('30');
    // The card lists both.
    expect(await cdp.evaluate(card, 'reminders')).toBe('30 minutes before');
    expect(await cdp.evaluate(card, 'notes')).toBe('bring the card');

    // A notification alone: the row joins and is the one marked.
    await cdp.say('remind 60');
    await cdp.waitUntil(($) => $.value('[data-testid="event-reminder-1"]') === '60');
    expect(await cdp.evaluate(valueOf, '[data-testid="event-reminder-0"]')).toBe('30');
    await cdp.waitUntil(
      ($) => $.text('[data-testid="assistant-changed"]') === 'Changed: notifications',
    );
    await cdp.waitUntil(marked, '[data-testid="event-reminders"]');
    expect(await cdp.evaluate(marked, '[data-testid="editor-notes"]')).toBe(false);
    // A note added by a step joins the notes on a line of its own.
    await cdp.say('note: ask about the fee');
    await cdp.waitUntil(
      ($) => $.value('[data-testid="editor-notes"]') === 'bring the card\nask about the fee',
    );
    expect(await cdp.evaluate(valueOf, '[data-testid="event-reminder-1"]')).toBe('60');
    await cdp.waitUntil(marked, '[data-testid="editor-notes"]');
    expect(await cdp.evaluate(marked, '[data-testid="event-reminders"]')).toBe(false);
    // Undo, kept: the note is back, the notifications with it untouched.
    await cdp.clickTestId('assistant-undo');
    await cdp.waitUntil(($) => $.value('[data-testid="editor-notes"]') === 'bring the card');
    await cdp.clickTestId('step-use');
    await cdp.waitUntil(($) => $.text('[data-testid="step-position"]') === '2 of 2');
    expect(await cdp.evaluate(valueOf, '[data-testid="editor-notes"]')).toBe('bring the card');
    expect(await cdp.evaluate(valueOf, '[data-testid="event-reminder-1"]')).toBe('60');
  });

  it('lists every step in the conversation, the newest as a card, and marks what it changed in the form', async () => {
    const { cdp } = app;
    await cdp.evaluate(commandN);
    await cdp.waitUntil(($) => $.text('[data-testid="editor-title"]') === 'New event');
    await cdp.say('Gym | +3 | 07:00-08:00');
    await cdp.waitUntil(blockAt, '07:00');
    for (const [start, end] of [
      ['08:00', '09:00'],
      ['09:00', '10:00'],
      ['10:00', '11:00'],
    ] as const) {
      await cdp.say(`| | ${start}-${end}`);
      await cdp.waitUntil(blockAt, start);
    }
    // One phrase, one step: four said, three rows and the card of the fourth.
    await cdp.waitUntil(($) => $.text('[data-testid="step-position"]') === '4 of 4');
    expect(await cdp.evaluate(said)).toBe(4);
    expect(await cdp.evaluate(versions)).toBe(3);
    expect(await cdp.evaluate(card, 'time')).toBe('10:00–11:0009:00–10:00');
    // The first row is the step that made it.
    expect(
      await cdp.evaluate(($) => $.el('[data-testid="assistant-version"]')!.textContent),
    ).toContain('Gym');
    // The form marks the times the last step moved, and stays marked; the title it left alone.
    await cdp.showEditorView('form');
    expect(await cdp.evaluate(marked, START)).toBe(true);
    expect(await cdp.evaluate(marked, TITLE)).toBe(false);
    // An edit by hand is a step too, and the newest: nothing is marked under the hand.
    await cdp.type(TITLE, ' (legs)');
    await cdp.waitUntil(($) => $.text('[data-testid="step-position"]') === '5 of 5');
    await cdp.waitUntil(($, start: string) => !($.el(start)?.dataset.marked === ''), START);
    // Back in the conversation it is a row's worth: the card of version 5, by hand.
    await cdp.showEditorView('assistant');
    expect(await cdp.evaluate(versions)).toBe(4);
    expect(await cdp.evaluate(card, 'title')).toContain('(legs)');
  });

  it('opens a pasted mail as one thread of drafts: the pager and the blocks switch the form, Remove drops one, Add all writes the rest', async () => {
    const { cdp } = app;
    // All on today: a block is clicked on the grid, and a draft a day on
    // sits in next week on a Sunday, off the week on view.
    await cdp.evaluate(
      paste,
      [
        // All on today, so every block is on the grid together whatever the
        // weekday: on the week's last day "+1" is next week's first.
        'Standup | +0 | 09:00-09:30 | Room 4',
        'Planning | +0 | 14:00-15:00',
        'Review | +0 | 16:00-17:00',
      ].join('\n'),
    );
    await cdp.waitUntil(($) => $.text('[data-testid="draft-position"]') === '1 of 3');
    await cdp.waitUntil(($) => $.count('[data-testid="draft-block"]') === 3);
    expect(await cdp.evaluate(titleIs, TITLE, 'Standup')).toBe(true);
    // The conversation: the focused draft as a card, the others a line each.
    expect(await cdp.evaluate(card, 'title')).toBe('Standup');
    expect(await cdp.evaluate(($) => $.count('[data-testid="assistant-draft"]'))).toBe(2);

    // A click on another draft's block focuses it.
    const planning = await cdp.locate('[data-testid="draft-block"][data-draft-start="14:00"]');
    await cdp.click(planning.x, planning.y);
    await cdp.waitUntil(($) => $.text('[data-testid="draft-position"]') === '2 of 3');
    await cdp.waitUntil(titleIs, TITLE, 'Planning');
    expect(
      await cdp.evaluate(($) =>
        $.has('[data-testid="draft-block"][data-draft-start="14:00"][data-focused]'),
      ),
    ).toBe(true);

    // The pager: next, then Remove drops the third.
    await cdp.clickTestId('draft-next');
    await cdp.waitUntil(($) => $.text('[data-testid="draft-position"]') === '3 of 3');
    await cdp.waitUntil(titleIs, TITLE, 'Review');
    await cdp.clickTestId('draft-remove');
    await cdp.waitUntil(($) => $.text('[data-testid="draft-position"]') === '2 of 2');
    await cdp.waitUntil(($) => $.count('[data-testid="draft-block"]') === 2);
    await cdp.waitUntil(titleIs, TITLE, 'Planning');

    // Add all: both written, the editor closed, no draft left.
    await cdp.clickTestId('draft-add-all');
    await cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));
    await cdp.waitUntil(($) => $.count('[data-testid="draft-block"]') === 0);
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
    await cdp.evaluate(
      paste,
      [
        'Breakfast | +0 | 08:00-08:30',
        'Buy milk | +1 | 07:00-07:30',
        'Post office | +1',
        'Retro | +1 | 16:00-17:00',
      ].join('\n'),
    );
    await cdp.waitUntil(($) => $.text('[data-testid="draft-position"]') === '1 of 4');
    await cdp.waitUntil(titleIs, TITLE, 'Breakfast');
    // By hand from here: the form, with the pager above it as above the conversation.
    await cdp.showEditorView('form');

    // The first goes to Yoga: its block takes the color.
    await cdp.evaluate(setSelect, CALENDAR, 'acc-e2e:cal-yoga');
    await cdp.waitUntil(
      ($, yoga: string) =>
        ($.el('[data-testid="draft-block"][data-draft-start="08:00"]')?.dataset.color ?? '') ===
        yoga,
      YOGA,
    );

    // The second becomes a task on the Google list.
    await cdp.clickTestId('draft-next');
    await cdp.waitUntil(titleIs, TITLE, 'Post office');
    await cdp.clickTestId('mode-task');
    await cdp.waitUntil(headingIs, 'New task');
    expect(await cdp.evaluate(valueOf, LIST)).toBe('acc-e2e:list-errands');

    // The third shows as the event it is — not a task, nothing asked —
    // and becomes a high-priority reminder.
    await cdp.clickTestId('draft-next');
    await cdp.waitUntil(titleIs, TITLE, 'Buy milk');
    expect(await cdp.evaluate(headingIs, 'New event')).toBe(true);
    expect(await cdp.evaluate(asked)).toBe(false);
    await cdp.clickTestId('mode-reminder');
    await cdp.waitUntil(headingIs, 'New reminder');
    await cdp.evaluate(pickPriority, 'High');
    await cdp.waitUntil(
      ($) => $.text('[aria-label="Priority"] [role="radio"][aria-checked="true"]') === 'High',
    );

    // The fourth, never shown, starts in the calendar the form has (Yoga); it goes to Work.
    await cdp.clickTestId('draft-next');
    await cdp.waitUntil(titleIs, TITLE, 'Retro');
    await cdp.waitUntil(headingIs, 'New event');
    expect(await cdp.evaluate(valueOf, CALENDAR)).toBe('acc-e2e:cal-yoga');
    await cdp.evaluate(setSelect, CALENDAR, 'acc-e2e:cal-e2e');

    // Back through them: each as it was left, and nothing asked.
    await cdp.clickTestId('draft-prev');
    await cdp.waitUntil(titleIs, TITLE, 'Buy milk');
    await cdp.waitUntil(headingIs, 'New reminder');
    expect(await cdp.evaluate(priority)).toBe('High');
    expect(await cdp.evaluate(valueOf, LIST)).toBe(`${APPLE_REMINDERS_ACCOUNT_ID}:ek-groceries`);
    await cdp.clickTestId('draft-prev');
    await cdp.waitUntil(titleIs, TITLE, 'Post office');
    await cdp.waitUntil(headingIs, 'New task');
    expect(await cdp.evaluate(valueOf, LIST)).toBe('acc-e2e:list-errands');
    await cdp.clickTestId('draft-prev');
    await cdp.waitUntil(titleIs, TITLE, 'Breakfast');
    await cdp.waitUntil(headingIs, 'New event');
    expect(await cdp.evaluate(valueOf, CALENDAR)).toBe('acc-e2e:cal-yoga');
    expect(await cdp.evaluate(asked)).toBe(false);
    // Each event draft drawn in its own calendar's color.
    await cdp.waitUntil(
      ($, work: string) =>
        ($.el('[data-testid="draft-block"][data-draft-start="16:00"]')?.dataset.color ?? '') ===
        work,
      WORK,
    );
    expect(await cdp.evaluate(colorAt, '08:00')).toBe(YOGA);

    // Add all: every draft where it was put, as what it was made.
    await cdp.clickTestId('draft-add-all');
    await cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));
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
    await cdp.evaluate(
      paste,
      ['Dinner | +0 | 19:00-20:00 | Room 4', 'Retro | +1 | 16:00-17:00'].join('\n'),
    );
    await cdp.waitUntil(($) => $.text('[data-testid="draft-position"]') === '1 of 2');
    await cdp.waitUntil(titleIs, TITLE, 'Dinner');
    await cdp.showEditorView('form');
    // A to-do has no place: the switch asks before it lets go of one.
    await cdp.clickTestId('mode-task');
    await cdp.waitUntil(asked);
    // The answer is this draft's. Until it is given the form is between
    // two kinds, and the pager and Remove wait: moved on, the answer would
    // land on the draft focused by then.
    expect(await cdp.evaluate(disabled, 'draft-next')).toBe(true);
    expect(await cdp.evaluate(disabled, 'draft-remove')).toBe(true);
    await cdp.clickTestId('move-confirm-yes');
    await cdp.waitUntil(headingIs, 'New task');
    expect(await cdp.evaluate(titleIs, TITLE, 'Dinner')).toBe(true);
    expect(await cdp.evaluate(position)).toBe('1 of 2');
    // The other draft is as it came.
    await cdp.waitUntil(
      ($) => !($.el<HTMLButtonElement>('[data-testid="draft-next"]')?.disabled === true),
    );
    await cdp.clickTestId('draft-next');
    await cdp.waitUntil(titleIs, TITLE, 'Retro');
    await cdp.waitUntil(headingIs, 'New event');
  });

  it('gives a to-do the alert the phrase says, writes it on a Reminders list, and refuses one where the list keeps none', async () => {
    const { cdp } = app;
    await cdp.evaluate(commandN);
    await cdp.waitUntil(headingIs, 'New event');
    // A repeat picked by hand before the phrase: the switch to a reminder
    // carries it over, and the phrase's alert must not take it away.
    await cdp.showEditorView('form');
    await cdp.evaluate(setSelect, REPEAT, 'weekly');
    await cdp.waitUntil(($, repeat: string) => $.value(repeat) === 'weekly', REPEAT);
    await cdp.showEditorView('assistant');
    // The fixture's extras: the model answers the to-do with an alert 10 minutes before.
    await cdp.say('todo: Call the bank | +1 | 09:00 | | remind 10');
    await cdp.waitUntil(
      ($) => $.text('[data-testid="assistant-card-alert"]') === '10 minutes before',
    );
    // A later turn keeps the kind: the form holds all of the step — a
    // to-do's own notes too — from the moment the step control shows it.
    const notesAtStep = await cdp.noteWhen(
      ($) => $.text('[data-testid="step-position"]') === '2 of 2',
      ($, notes: string) => $.value(notes),
      NOTES,
    );
    await cdp.say('note: ask about the fees');
    await cdp.waitUntil(($) => $.text('[data-testid="step-position"]') === '2 of 2');
    expect(await notesAtStep()).toBe('ask about the fees');
    await cdp.showEditorView('form');
    // A to-do goes to the Reminders list (over the Google one): its alert is in the picker,
    // named though the presets lack it.
    await cdp.waitUntil(headingIs, 'New reminder');
    expect(await cdp.evaluate(valueOf, ALERT)).toBe('-10');
    expect(await cdp.evaluate(alertLabel, ALERT)).toBe('10 minutes before');
    expect(await cdp.evaluate(valueOf, REPEAT)).toBe('weekly');
    await cdp.clickButtonWithText('Save');
    await cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));
    await expect
      .poll(async () => {
        const call = (await readTasks(app.userDataDir)).find(
          (task) => task.title === 'Call the bank',
        );
        return [call?.listId, call?.dueTime, call?.alarms, call?.recurrence?.freq];
      })
      .toEqual(['ek-groceries', '09:00', [-10], 'weekly']);

    // On the Google list a to-do keeps no alert: a turn that adds one is
    // refused, and nothing of it lands.
    await cdp.evaluate(commandN);
    await cdp.waitUntil(headingIs, 'New event');
    await cdp.say('todo: Post the letter | +1');
    await cdp.waitUntil(titleIs, TITLE, 'Post the letter');
    await cdp.showEditorView('form');
    await cdp.clickTestId('mode-task');
    await cdp.waitUntil(
      ($) =>
        $.text('[data-testid="editor-title"]') === 'New task' ||
        $.has('[data-testid="move-confirm"]'),
    );
    if (await cdp.evaluate(asked)) {
      await cdp.clickTestId('move-confirm-yes');
    }
    await cdp.waitUntil(headingIs, 'New task');
    await cdp.showEditorView('assistant');
    // The phrase and the switch by hand are the steps so far.
    const steps = await cdp.evaluate(stepPosition);
    await cdp.say('remind 10');
    await cdp.waitUntil(
      ($) =>
        $.text('[data-testid="quick-add-status"]') ===
        'This list keeps no alerts — an alert can’t be saved here.',
    );
    expect(await cdp.evaluate(stepPosition)).toBe(steps);
    expect(await cdp.evaluate(card, 'alert')).toBe('');
  });

  it('starts new events and the Assistant’s drafts in the default calendar Settings › Calendar picks', async () => {
    const { cdp } = app;
    const PICKER = '[data-testid="default-calendar-select"]';
    const stored = () => readDeviceSetting(app.userDataDir, 'newEvents');
    const settings = await app.openSettings('calendar');
    try {
      // Nothing chosen yet: Last used.
      await settings.waitUntil(($, picker: string) => $.value(picker) === 'lastUsed', PICKER);
      await settings.evaluate(setSelect, PICKER, 'acc-e2e:cal-yoga');
      // Stored the portable way, as the settings file and the iPhone name it.
      await expect.poll(stored, { timeout: 10_000 }).toEqual({
        calendar: {
          calendarId: 'cal-yoga',
          email: 'e2e@example.com',
          kind: 'google',
          title: 'Yoga',
        },
      });

      // The Assistant's draft starts in Yoga, drawn in its color, and Save writes it there.
      await cdp.evaluate(commandN);
      await cdp.waitUntil(headingIs, 'New event');
      expect(await cdp.evaluate(valueOf, CALENDAR)).toBe('acc-e2e:cal-yoga');
      await cdp.say('Stretch | +1 | 07:00-07:30');
      await cdp.waitUntil(blockAt, '07:00');
      expect(await cdp.evaluate(colorAt, '07:00')).toBe(YOGA);
      await cdp.clickButtonWithText('Save');
      await cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));
      await expect
        .poll(async () =>
          (await readEvents(app.userDataDir)).find((event) => event.title === 'Stretch'),
        )
        .toMatchObject({ calendarId: 'cal-yoga' });

      // One saved in Work by hand: the next new event still starts in Yoga.
      await cdp.evaluate(commandN);
      await cdp.waitUntil(headingIs, 'New event');
      await cdp.say('Plank | +1 | 08:00-08:30');
      await cdp.waitUntil(titleIs, TITLE, 'Plank');
      await cdp.showEditorView('form');
      await cdp.evaluate(setSelect, CALENDAR, 'acc-e2e:cal-e2e');
      await cdp.waitUntil(($, select: string) => $.value(select) === 'acc-e2e:cal-e2e', CALENDAR);
      await cdp.clickButtonWithText('Save');
      await cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));
      await expect
        .poll(async () =>
          (await readEvents(app.userDataDir)).find((event) => event.title === 'Plank'),
        )
        .toMatchObject({ calendarId: 'cal-e2e' });
      await cdp.evaluate(commandN);
      await cdp.waitUntil(headingIs, 'New event');
      expect(await cdp.evaluate(valueOf, CALENDAR)).toBe('acc-e2e:cal-yoga');
      await cdp.escapeOrDiscard();
      await cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));

      // Back to Last used: the default no longer holds, and the next new
      // event opens where Plank went (Work, not the default Yoga)…
      await settings.evaluate(setSelect, PICKER, 'lastUsed');
      await expect.poll(stored, { timeout: 10_000 }).toEqual({ calendar: 'lastUsed' });
      await cdp.evaluate(commandN);
      await cdp.waitUntil(headingIs, 'New event');
      expect(await cdp.evaluate(valueOf, CALENDAR)).toBe('acc-e2e:cal-e2e');
      // …and after one saved in Yoga, the next starts in Yoga, though Work sorts first.
      await cdp.say('Lunge | +1 | 09:00-09:30');
      await cdp.waitUntil(titleIs, TITLE, 'Lunge');
      await cdp.showEditorView('form');
      await cdp.evaluate(setSelect, CALENDAR, 'acc-e2e:cal-yoga');
      await cdp.waitUntil(($, select: string) => $.value(select) === 'acc-e2e:cal-yoga', CALENDAR);
      await cdp.clickButtonWithText('Save');
      await cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));
      await expect
        .poll(async () =>
          (await readEvents(app.userDataDir)).find((event) => event.title === 'Lunge'),
        )
        .toMatchObject({ calendarId: 'cal-yoga' });
      await cdp.evaluate(commandN);
      await cdp.waitUntil(headingIs, 'New event');
      expect(await cdp.evaluate(valueOf, CALENDAR)).toBe('acc-e2e:cal-yoga');
    } finally {
      await settings.evaluate(setSelect, PICKER, 'lastUsed');
      await app.closeSettings();
    }
  });
});
