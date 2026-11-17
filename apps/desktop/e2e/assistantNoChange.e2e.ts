import { Account, CalendarInfo, EventRecord, Temporal } from '@calendar/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readPendingOps } from './harness.ts';

// Words said to the Assistant that change nothing are answered in the
// conversation, and make no version: no card, no number, no Restore —
// there is nothing else to go back to. Dictated words then offer the
// recogniser's other readings that would change something, and one is
// said only when clicked. The model is the deterministic fixture (`Title
// | +N | HH:MM-HH:MM`, an empty part meaning "unchanged"), the microphone
// the harness's, saying the one phrase below as the recogniser read it.
const TZ = 'Europe/Vienna';
const today = Temporal.Now.plainDateISO(TZ);
const at = (hour: number): number =>
  today.toZonedDateTime({ plainTime: new Temporal.PlainTime(hour), timeZone: TZ }).toInstant()
    .epochMilliseconds;

const seed = {
  accounts: [
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      email: 'e2e@example.com',
      id: 'acc-e2e',
      provider: 'google',
      status: 'ok',
      tasksEnabled: false,
    }),
  ],
  calendars: [
    new CalendarInfo({
      accessRole: 'owner',
      accountId: 'acc-e2e',
      colorHex: '#16a34a',
      id: 'cal-e2e',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'Personal',
      timeZone: TZ,
    }),
  ],
  events: [
    new EventRecord({
      accountId: 'acc-e2e',
      calendarId: 'cal-e2e',
      endUtc: at(16),
      etag: '"1"',
      id: 'evt-review',
      isAllDay: false,
      startTimeZone: TZ,
      startUtc: at(15),
      status: 'confirmed',
      syncedAt: 1,
      syncStatus: 'synced',
      title: 'Design review',
      updatedAt: 1,
    }),
  ],
};

// The hours the draft already has, dictated: the recogniser weighed two
// other readings of them, which would move it.
const DICTATED = {
  segments: [
    { text: '| |' },
    { alternatives: [' 13:00-14:00', ' 14:00-15:00', ' 10:00-11:00'], text: ' 13:00-14:00' },
  ],
};

const COMMAND_N = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }))`;
const INPUT = `document.querySelector('[data-testid="quick-add-input"]')`;
const exists = (testId: string) => `!!document.querySelector('[data-testid="${testId}"]')`;
const count = (testId: string) => `document.querySelectorAll('[data-testid="${testId}"]').length`;
const textOf = (testId: string) =>
  `(document.querySelector('[data-testid="${testId}"]')?.textContent ?? '')`;
const textsOf = (testId: string) =>
  `[...document.querySelectorAll('[data-testid="${testId}"]')].map((each) => each.textContent ?? '')`;
const dimmed = `[...document.querySelectorAll('[data-testid="assistant-no-change"]')].map((each) => each.hasAttribute('data-dimmed'))`;
const stepPosition = textOf('step-position');
const cardTime = textOf('assistant-card-time');
const MIC = `document.querySelector('[data-testid="quick-add-mic"]')`;
const dictating = `${MIC}?.getAttribute('aria-pressed') === 'true'`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Words that change nothing', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, {
      env: { TZ },
      microphone: { phrases: [DICTATED] },
      model: 'fixture',
    });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });
  beforeEach(async () => {
    // The seeded event is today's: on show whatever an earlier test's `+1` showed.
    await app.cdp.clickTestId('today');
  }, 20_000);
  afterEach(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await app.cdp.eval<boolean>(exists('editor')))) {
        return;
      }
      await app.cdp.escapeOrDiscard();
      await sleep(150);
    }
  });

  it('answers them in the conversation without a version, and offers the other readings of dictated words', async () => {
    const { cdp } = app;
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(`${textOf('editor-title')} === 'New event'`);
    await cdp.say('Lunch with Sarah | +1 | 13:00-14:00');
    await cdp.waitFor(`${stepPosition} === '1 of 1'`);

    // Typed: the words stay, answered, and Version 1 is still the newest.
    await cdp.say('| | 13:00-14:00');
    await cdp.waitFor(`${count('assistant-reply')} === 1`);
    expect(await cdp.eval<string>(textOf('assistant-reply'))).toBe('Nothing changed.');
    expect(await cdp.eval<string>(stepPosition)).toBe('1 of 1');
    expect(await cdp.eval<number>(count('assistant-version'))).toBe(0);
    expect(await cdp.eval<number>(count('assistant-said'))).toBe(2);
    expect(await cdp.eval<string>(`${INPUT}.value`)).toBe('');
    // Nothing to offer for words typed.
    expect(await cdp.eval<number>(count('assistant-reading'))).toBe(0);

    // Dictated: the same hours, and two other readings that would move them.
    await cdp.clickTestId('quick-add-mic');
    await cdp.waitFor(`${count('assistant-reply')} === 2`, 20_000);
    await cdp.clickTestId('quick-add-mic');
    await cdp.waitFor(`!(${dictating})`);
    await cdp.waitFor(`${count('assistant-reading')} === 2`);
    expect(await cdp.eval<Array<string>>(textsOf('assistant-reading'))).toEqual([
      '“| | 14:00-15:00”→ 14:00–15:00',
      '“| | 10:00-11:00”→ 10:00–11:00',
    ]);
    expect(await cdp.eval<Array<string>>(textsOf('assistant-reply'))).toEqual([
      'Nothing changed.',
      expect.stringMatching(/^Nothing changed\. Did you mean/u),
    ]);
    // Only the newest answer is on show as one: the one before is history.
    expect(await cdp.eval<Array<boolean>>(dimmed)).toEqual([true, false]);
    expect(await cdp.eval<string>(stepPosition)).toBe('1 of 1');

    // One is said only when clicked: it is a step like any phrase. The
    // readings stay disabled while the recogniser finishes after Stop (no
    // offered words while a phrase may still come), so wait for them.
    await cdp.waitFor(
      `[...document.querySelectorAll('[data-testid="assistant-reading"]')].every((each) => !each.disabled)`,
    );
    await cdp.clickTestId('assistant-reading');
    await cdp.waitFor(`${stepPosition} === '2 of 2'`);
    expect(await cdp.eval<string>(cardTime)).toBe('14:00–15:0013:00–14:00');
    // The answers it followed stay, dimmed, offering nothing any more.
    expect(await cdp.eval<Array<boolean>>(dimmed)).toEqual([true, true]);
    expect(await cdp.eval<number>(count('assistant-reading'))).toBe(0);
    expect(await cdp.eval<number>(count('assistant-said'))).toBe(4);
    // One version to go back to, the first: the words that changed nothing are none.
    expect(await cdp.eval<number>(count('assistant-version'))).toBe(1);
  });

  it('answers words said to a saved item that change nothing, and Save sends nothing', async () => {
    const { cdp } = app;
    await cdp.openEditor('[title^="Design review"]');
    await cdp.showEditorView('assistant');
    await cdp.waitFor(`${textOf('assistant-card-title')} === 'Design review'`);
    await cdp.say('| | 15:00-16:00');
    await cdp.waitFor(`${count('assistant-reply')} === 1`);
    // No step: the item is as saved, and there is nothing to step through.
    expect(await cdp.eval<boolean>(exists('step-control'))).toBe(false);
    expect(await cdp.eval<string>(cardTime)).toBe('15:00–16:00');
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!${exists('editor')}`);
    const updates = (await readPendingOps(app.userDataDir)).filter(
      (op) => op.kind === 'update' && op.eventId === 'evt-review',
    );
    expect(updates).toEqual([]);
  });
});
