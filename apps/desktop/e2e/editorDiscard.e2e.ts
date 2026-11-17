import {
  Account,
  CalendarInfo,
  EventRecord,
  TaskListInfo,
  TaskRecord,
  Temporal,
} from '@calendar/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readEvents } from './harness.ts';

// The question before an editor that holds something goes: Cancel, the
// X, Escape and another event opened over it ask "Discard Changes" or
// "Keep Editing"; an editor as it opened, or put back as it was, and
// Save close at once. The model is the deterministic fixture
// (`Title | +N | HH:MM-HH:MM`), and the device zone is pinned so the
// seeded hours are the ones the grid shows on every host.
const TZ = 'Europe/Vienna';
const today = Temporal.Now.plainDateISO(TZ);
const at = (hour: number): number =>
  today.toZonedDateTime({ plainTime: new Temporal.PlainTime(hour), timeZone: TZ }).toInstant()
    .epochMilliseconds;

const stored = (id: string, title: string, hour: number, extra: Partial<EventRecord> = {}) =>
  new EventRecord({
    accountId: 'acc-e2e',
    calendarId: 'cal-e2e',
    endUtc: at(hour + 1),
    etag: '"1"',
    id,
    isAllDay: false,
    startTimeZone: TZ,
    startUtc: at(hour),
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    title,
    updatedAt: 1,
    ...extra,
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
  calendars: [
    new CalendarInfo({
      accessRole: 'owner',
      accountId: 'acc-e2e',
      colorHex: '#4285f4',
      id: 'cal-e2e',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'Work',
      timeZone: TZ,
    }),
  ],
  events: [
    stored('evt-coffee', 'Coffee chat', 9),
    stored('evt-lunch', 'Lunch plan', 12),
    // A series: its occurrences' editor reads the rule from the master after it opens.
    stored('evt-daily', 'Daily sync', 15, { recurrence: ['RRULE:FREQ=DAILY;COUNT=14'] }),
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
      dueDate: today.toString(),
      id: 'task-water',
      listId: 'list-e2e',
      notes: 'Bring the can',
      provider: 'google',
      status: 'needsAction',
      title: 'Water plants',
      updatedAt: 1,
    }),
  ],
};

// CDP key events don't carry macOS meta reliably: dispatch ⌘N to the app's own window listener.
const commandN = () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }));
};
const TITLE = 'input[placeholder="Title"]';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Discarding an editor that holds something', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { env: { TZ }, model: 'fixture' });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });
  beforeEach(async () => {
    await app.cdp.clickTestId('today');
  }, 20_000);
  afterEach(async () => {
    // A failure above must not strand an editor for the next test.
    if (await app.cdp.evaluate(($) => $.has('[data-testid="editor"]'))) {
      await app.cdp.discardEditor();
    }
  });

  /** Sets the form's title as typing would, all at once. */
  const setTitle = (text: string) =>
    app.cdp.evaluate(($, title: string, value: string) => $.setValue(title, value), TITLE, text);
  /** Waits for the editor's heading to read `text`. */
  const headingIs = (text: string) =>
    app.cdp.waitUntil(($, want: string) => $.text('[data-testid="editor-title"]') === want, text);
  /** A new event on its form: ⌘N, then the Form tab. */
  const openNewForm = async () => {
    await app.cdp.evaluate(commandN);
    await headingIs('New event');
    await app.cdp.showEditorView('form');
  };
  /** The editor is still up a moment after: nothing closed it, and no question came. */
  const staysUp = async () => {
    await sleep(300);
    expect(await app.cdp.evaluate(($) => $.has('[data-testid="editor"]'))).toBe(true);
  };
  const closesAtOnce = async () => {
    await app.cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));
    expect(await app.cdp.evaluate(($) => $.has('[data-testid="discard-confirm"]'))).toBe(false);
  };

  it('asks before Cancel, the X or Escape drops a new event; Keep Editing keeps it, Discard closes it', async () => {
    const { cdp } = app;
    await openNewForm();
    await setTitle('Half written');

    await cdp.clickButtonWithText('Cancel');
    await cdp.waitUntil(($) => $.has('[data-testid="discard-confirm"]'));
    expect(await cdp.evaluate(($) => $.text('[data-testid="discard-confirm"]'))).toContain(
      'Are you sure you want to discard this new event?',
    );
    // The safe answer holds the focus: Enter keeps the draft.
    expect(await cdp.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
      'discard-confirm-no',
    );
    await cdp.answerDiscard(false);
    await staysUp();
    expect(await cdp.evaluate(($, title: string) => $.value(title), TITLE)).toBe('Half written');

    // The X asks the same; Escape while it asks is Keep Editing.
    await cdp.clickTestId('editor-close');
    await cdp.waitUntil(($) => $.has('[data-testid="discard-confirm"]'));
    await cdp.pressEscape();
    await cdp.waitUntil(($) => !$.has('[data-testid="discard-confirm"]'));
    await staysUp();

    // Escape asks too, and Discard Changes closes the editor with nothing written.
    await cdp.pressEscape();
    await cdp.waitUntil(($) => $.has('[data-testid="discard-confirm"]'));
    await cdp.answerDiscard(true);
    await cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));
    expect((await readEvents(app.userDataDir)).some((e) => e.title === 'Half written')).toBe(false);
  });

  it('asks before another event replaces the editor, and Discard opens that one', async () => {
    const { cdp } = app;
    await openNewForm();
    await setTitle('Half written');
    await cdp.openInspector('[title^="Coffee chat"]').catch(() => undefined);
    // The click asked instead of replacing the editor.
    await cdp.waitUntil(($) => $.has('[data-testid="discard-confirm"]'));
    expect(await cdp.evaluate(($) => $.has('[data-testid="inspector"]'))).toBe(false);
    await cdp.answerDiscard(true);
    await cdp.waitUntil(($) => $.has('[data-testid="inspector"]'));
    expect(await cdp.evaluate(($) => $.text('[data-testid="inspector"]'))).toContain('Coffee chat');
    await cdp.pressEscape();
  });

  it('closes at once as it opened, put back as it was, and on Save', async () => {
    const { cdp } = app;
    // Opened and left alone: a new event's seed is no change.
    await openNewForm();
    await cdp.pressEscape();
    await closesAtOnce();

    // Made a task before anything was put in: the task form opens afresh.
    await openNewForm();
    await cdp.clickTestId('mode-task');
    await headingIs('New task');
    await cdp.pressEscape();
    await closesAtOnce();

    // And back: the event form the task's values made opens afresh too.
    await openNewForm();
    await cdp.clickTestId('mode-task');
    await headingIs('New task');
    await cdp.clickTestId('mode-event');
    await headingIs('New event');
    await cdp.pressEscape();
    await closesAtOnce();

    // A series' occurrence: its rule arrives after the editor opened, and is no change.
    // Today's, not the first: an occurrence row has no rule of its own.
    await cdp.openEditor(`[data-day="${today.toString()}"] [title^="Daily sync"]`);
    await cdp.waitUntil(($) => $.value('select[aria-label="Repeat"]') === 'daily');
    await sleep(300);
    await cdp.pressEscape();
    await closesAtOnce();

    // Its repeat taken away is a change, though the rule is not in the reading until it is.
    await cdp.openEditor(`[data-day="${today.toString()}"] [title^="Daily sync"]`);
    await cdp.waitUntil(($) => $.value('select[aria-label="Repeat"]') === 'daily');
    await cdp.evaluate(($) => $.setValue('select[aria-label="Repeat"]', 'none'));
    await cdp.waitUntil(($) => $.value('select[aria-label="Repeat"]') === 'none');
    await cdp.pressEscape();
    await cdp.waitUntil(($) => $.has('[data-testid="discard-confirm"]'));
    expect(await cdp.evaluate(($) => $.text('[data-testid="discard-confirm"]'))).toContain(
      'discard your changes',
    );
    await cdp.answerDiscard(true);
    await cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));

    // A title typed, then made a task: the title goes along, and is asked about.
    await openNewForm();
    await setTitle('Half written');
    await cdp.clickTestId('mode-task');
    await headingIs('New task');
    await cdp.pressEscape();
    await cdp.waitUntil(($) => $.has('[data-testid="discard-confirm"]'));
    expect(await cdp.evaluate(($) => $.text('[data-testid="discard-confirm"]'))).toContain(
      'this new task',
    );
    await cdp.answerDiscard(true);
    await cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));

    // A saved event's title changed and put back: the form reads as it opened.
    await cdp.openEditor('[title^="Coffee chat"]');
    await setTitle('Coffee chat moved');
    await setTitle('Coffee chat');
    await cdp.clickButtonWithText('Cancel');
    await closesAtOnce();

    // Changed and saved: Save never asks.
    await cdp.openEditor('[title^="Lunch plan"]');
    await setTitle('Lunch plan moved');
    await cdp.clickButtonWithText('Save');
    await closesAtOnce();
    await cdp.waitUntil(($) => $.has('[title^="Lunch plan moved"]'));
  });

  it('lets a saved to-do taken through Event and back close at once', async () => {
    const { cdp } = app;
    await cdp.clickTaskChip('[title="Water plants"]');
    await headingIs('Edit task');
    // Its notes go into the hidden event form on the way: no change of the to-do's.
    await cdp.clickTestId('mode-event');
    await cdp.waitUntil(
      ($) =>
        $.text('[data-testid="editor-title"]') === 'Convert to event' ||
        $.has('[data-testid="move-confirm"]'),
    );
    if (await cdp.evaluate(($) => $.has('[data-testid="move-confirm"]'))) {
      await cdp.clickTestId('move-confirm-yes');
      await headingIs('Convert to event');
    }
    await cdp.clickTestId('mode-task');
    await headingIs('Edit task');
    await cdp.pressEscape();
    await closesAtOnce();
  });

  it("asks about the Assistant's draft, and about words in its field not sent yet", async () => {
    const { cdp } = app;
    await cdp.evaluate(commandN);
    await headingIs('New event');
    // Typed and not sent: the words would go with the editor.
    await cdp.type('[data-testid="quick-add-input"]', 'Dinner');
    await cdp.clickButtonWithText('Cancel');
    await cdp.waitUntil(($) => $.has('[data-testid="discard-confirm"]'));
    await cdp.answerDiscard(false);

    // Sent: a draft, asked about by its kind.
    await cdp.evaluate(($) => $.el<HTMLInputElement>('[data-testid="quick-add-input"]')!.select());
    await cdp.say('Dinner | +0 | 19:00-20:00');
    await cdp.waitUntil(($) => $.text('[data-testid="assistant-card-title"]').includes('Dinner'));
    await cdp.clickButtonWithText('Cancel');
    await cdp.waitUntil(($) => $.has('[data-testid="discard-confirm"]'));
    expect(await cdp.evaluate(($) => $.text('[data-testid="discard-confirm"]'))).toContain(
      'this new event',
    );
    await cdp.answerDiscard(true);
    await cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));
  });
});
