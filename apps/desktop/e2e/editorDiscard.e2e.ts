import { Account, CalendarInfo, EventRecord, TaskListInfo, Temporal } from '@calendar/core';
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
};

// CDP key events don't carry macOS meta reliably: dispatch ⌘N to the app's own window listener.
const COMMAND_N = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }))`;
const TITLE = 'input[placeholder="Title"]';
const exists = (testId: string) => `!!document.querySelector('[data-testid="${testId}"]')`;
const textOf = (testId: string) =>
  `(document.querySelector('[data-testid="${testId}"]')?.textContent ?? '')`;
const valueOf = (selector: string) =>
  `(document.querySelector(${JSON.stringify(selector)})?.value ?? '')`;
const headingIs = (text: string) => `${textOf('editor-title')} === ${JSON.stringify(text)}`;
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
    if (await app.cdp.eval<boolean>(exists('editor'))) {
      await app.cdp.discardEditor();
    }
  });

  /** Sets the form's title as typing would, all at once. */
  const setTitle = (text: string) =>
    app.cdp.eval(`(() => {
      const input = document.querySelector(${JSON.stringify(TITLE)});
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  /** A new event on its form: ⌘N, then the Form tab. */
  const openNewForm = async () => {
    await app.cdp.eval(COMMAND_N);
    await app.cdp.waitFor(headingIs('New event'));
    await app.cdp.showEditorView('form');
  };
  /** The editor is still up a moment after: nothing closed it, and no question came. */
  const staysUp = async () => {
    await sleep(300);
    expect(await app.cdp.eval<boolean>(exists('editor'))).toBe(true);
  };
  const closesAtOnce = async () => {
    await app.cdp.waitFor(`!${exists('editor')}`);
    expect(await app.cdp.eval<boolean>(exists('discard-confirm'))).toBe(false);
  };

  it('asks before Cancel, the X or Escape drops a new event; Keep Editing keeps it, Discard closes it', async () => {
    const { cdp } = app;
    await openNewForm();
    await setTitle('Half written');

    await cdp.clickButtonWithText('Cancel');
    await cdp.waitFor(exists('discard-confirm'));
    expect(await cdp.eval<string>(textOf('discard-confirm'))).toContain(
      'Are you sure you want to discard this new event?',
    );
    // The safe answer holds the focus: Enter keeps the draft.
    expect(
      await cdp.eval<string>(`document.activeElement?.getAttribute('data-testid') ?? ''`),
    ).toBe('discard-confirm-no');
    await cdp.answerDiscard(false);
    await staysUp();
    expect(await cdp.eval<string>(valueOf(TITLE))).toBe('Half written');

    // The X asks the same; Escape while it asks is Keep Editing.
    await cdp.clickTestId('editor-close');
    await cdp.waitFor(exists('discard-confirm'));
    await cdp.pressEscape();
    await cdp.waitFor(`!${exists('discard-confirm')}`);
    await staysUp();

    // Escape asks too, and Discard Changes closes the editor with nothing written.
    await cdp.pressEscape();
    await cdp.waitFor(exists('discard-confirm'));
    await cdp.answerDiscard(true);
    await cdp.waitFor(`!${exists('editor')}`);
    expect((await readEvents(app.userDataDir)).some((e) => e.title === 'Half written')).toBe(false);
  });

  it('asks before another event replaces the editor, and Discard opens that one', async () => {
    const { cdp } = app;
    await openNewForm();
    await setTitle('Half written');
    await cdp.openInspector('[title^="Coffee chat"]').catch(() => undefined);
    // The click asked instead of replacing the editor.
    await cdp.waitFor(exists('discard-confirm'));
    expect(await cdp.eval<boolean>(exists('inspector'))).toBe(false);
    await cdp.answerDiscard(true);
    await cdp.waitFor(exists('inspector'));
    expect(await cdp.eval<string>(textOf('inspector'))).toContain('Coffee chat');
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
    await cdp.waitFor(headingIs('New task'));
    await cdp.pressEscape();
    await closesAtOnce();

    // And back: the event form the task's values made opens afresh too.
    await openNewForm();
    await cdp.clickTestId('mode-task');
    await cdp.waitFor(headingIs('New task'));
    await cdp.clickTestId('mode-event');
    await cdp.waitFor(headingIs('New event'));
    await cdp.pressEscape();
    await closesAtOnce();

    // A series' occurrence: its rule arrives after the editor opened, and is no change.
    // Today's, not the first: an occurrence row has no rule of its own.
    await cdp.openEditor(`[data-day="${today.toString()}"] [title^="Daily sync"]`);
    await cdp.waitFor(`document.querySelector('select[aria-label="Repeat"]')?.value === 'daily'`);
    await sleep(300);
    await cdp.pressEscape();
    await closesAtOnce();

    // Its repeat taken away is a change, though the rule is not in the reading until it is.
    await cdp.openEditor(`[data-day="${today.toString()}"] [title^="Daily sync"]`);
    await cdp.waitFor(`document.querySelector('select[aria-label="Repeat"]')?.value === 'daily'`);
    await cdp.eval(`(() => {
      const select = document.querySelector('select[aria-label="Repeat"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'none');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await cdp.waitFor(`document.querySelector('select[aria-label="Repeat"]')?.value === 'none'`);
    await cdp.pressEscape();
    await cdp.waitFor(exists('discard-confirm'));
    expect(await cdp.eval<string>(textOf('discard-confirm'))).toContain('discard your changes');
    await cdp.answerDiscard(true);
    await cdp.waitFor(`!${exists('editor')}`);

    // A title typed, then made a task: the title goes along, and is asked about.
    await openNewForm();
    await setTitle('Half written');
    await cdp.clickTestId('mode-task');
    await cdp.waitFor(headingIs('New task'));
    await cdp.pressEscape();
    await cdp.waitFor(exists('discard-confirm'));
    expect(await cdp.eval<string>(textOf('discard-confirm'))).toContain('this new task');
    await cdp.answerDiscard(true);
    await cdp.waitFor(`!${exists('editor')}`);

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
    await cdp.waitFor(`!!document.querySelector('[title^="Lunch plan moved"]')`);
  });

  it("asks about the Assistant's draft, and about words in its field not sent yet", async () => {
    const { cdp } = app;
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(headingIs('New event'));
    // Typed and not sent: the words would go with the editor.
    await cdp.type('[data-testid="quick-add-input"]', 'Dinner');
    await cdp.clickButtonWithText('Cancel');
    await cdp.waitFor(exists('discard-confirm'));
    await cdp.answerDiscard(false);

    // Sent: a draft, asked about by its kind.
    await cdp.eval(`document.querySelector('[data-testid="quick-add-input"]').select()`);
    await cdp.say('Dinner | +0 | 19:00-20:00');
    await cdp.waitFor(`${textOf('assistant-card-title')}.includes('Dinner')`);
    await cdp.clickButtonWithText('Cancel');
    await cdp.waitFor(exists('discard-confirm'));
    expect(await cdp.eval<string>(textOf('discard-confirm'))).toContain('this new event');
    await cdp.answerDiscard(true);
    await cdp.waitFor(`!${exists('editor')}`);
  });
});
