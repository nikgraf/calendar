import { Account, CalendarInfo, EventRecord, Temporal } from '@calendar/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readPendingOps } from './harness.ts';
import type { PageKit } from './page.ts';

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

const commandN = () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }));
};
const INPUT = '[data-testid="quick-add-input"]';
const exists = ($: PageKit, testId: string) => $.has(`[data-testid="${testId}"]`);
const count = ($: PageKit, testId: string) => $.count(`[data-testid="${testId}"]`);
const textOf = ($: PageKit, testId: string) => $.text(`[data-testid="${testId}"]`);
const textsOf = ($: PageKit, testId: string) =>
  $.all(`[data-testid="${testId}"]`).map((each) => each.textContent ?? '');
const dimmed = ($: PageKit) =>
  $.all('[data-testid="assistant-no-change"]').map((each) => each.hasAttribute('data-dimmed'));
const stepPosition = ($: PageKit) => $.text('[data-testid="step-position"]');
const cardTime = ($: PageKit) => $.text('[data-testid="assistant-card-time"]');
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
      if (!(await app.cdp.evaluate(exists, 'editor'))) {
        return;
      }
      await app.cdp.escapeOrDiscard();
      await sleep(150);
    }
  });

  it('answers them in the conversation without a version, and offers the other readings of dictated words', async () => {
    const { cdp } = app;
    await cdp.evaluate(commandN);
    await cdp.waitUntil(($) => $.text('[data-testid="editor-title"]') === 'New event');
    await cdp.say('Lunch with Sarah | +1 | 13:00-14:00');
    await cdp.waitUntil(($) => $.text('[data-testid="step-position"]') === '1 of 1');

    // Typed: the words stay, answered, and Version 1 is still the newest.
    await cdp.say('| | 13:00-14:00');
    await cdp.waitUntil(($) => $.count('[data-testid="assistant-reply"]') === 1);
    expect(await cdp.evaluate(textOf, 'assistant-reply')).toBe('Nothing changed.');
    expect(await cdp.evaluate(stepPosition)).toBe('1 of 1');
    expect(await cdp.evaluate(count, 'assistant-version')).toBe(0);
    expect(await cdp.evaluate(count, 'assistant-said')).toBe(2);
    expect(
      await cdp.evaluate(($, input: string) => $.el<HTMLInputElement>(input)!.value, INPUT),
    ).toBe('');
    // Nothing to offer for words typed.
    expect(await cdp.evaluate(count, 'assistant-reading')).toBe(0);

    // Dictated: the same hours, and two other readings that would move them.
    await cdp.clickTestId('quick-add-mic');
    await cdp.waitUntil(
      { timeoutMs: 20_000 },
      ($) => $.count('[data-testid="assistant-reply"]') === 2,
    );
    await cdp.clickTestId('quick-add-mic');
    await cdp.waitUntil(
      ($) => $.el('[data-testid="quick-add-mic"]')?.getAttribute('aria-pressed') !== 'true',
    );
    await cdp.waitUntil(($) => $.count('[data-testid="assistant-reading"]') === 2);
    expect(await cdp.evaluate(textsOf, 'assistant-reading')).toEqual([
      '“| | 14:00-15:00”→ 14:00–15:00',
      '“| | 10:00-11:00”→ 10:00–11:00',
    ]);
    expect(await cdp.evaluate(textsOf, 'assistant-reply')).toEqual([
      'Nothing changed.',
      expect.stringMatching(/^Nothing changed\. Did you mean/u),
    ]);
    // Only the newest answer is on show as one: the one before is history.
    expect(await cdp.evaluate(dimmed)).toEqual([true, false]);
    expect(await cdp.evaluate(stepPosition)).toBe('1 of 1');

    // One is said only when clicked: it is a step like any phrase. The
    // readings stay disabled while the recogniser finishes after Stop (no
    // offered words while a phrase may still come), so wait for them.
    await cdp.waitUntil(($) =>
      $.all<HTMLButtonElement>('[data-testid="assistant-reading"]').every((each) => !each.disabled),
    );
    await cdp.clickTestId('assistant-reading');
    await cdp.waitUntil(($) => $.text('[data-testid="step-position"]') === '2 of 2');
    expect(await cdp.evaluate(cardTime)).toBe('14:00–15:0013:00–14:00');
    // The answers it followed stay, dimmed, offering nothing any more.
    expect(await cdp.evaluate(dimmed)).toEqual([true, true]);
    expect(await cdp.evaluate(count, 'assistant-reading')).toBe(0);
    expect(await cdp.evaluate(count, 'assistant-said')).toBe(4);
    // One version to go back to, the first: the words that changed nothing are none.
    expect(await cdp.evaluate(count, 'assistant-version')).toBe(1);
  });

  it('answers words said to a saved item that change nothing, and Save sends nothing', async () => {
    const { cdp } = app;
    await cdp.openEditor('[title^="Design review"]');
    await cdp.showEditorView('assistant');
    await cdp.waitUntil(($) => $.text('[data-testid="assistant-card-title"]') === 'Design review');
    await cdp.say('| | 15:00-16:00');
    await cdp.waitUntil(($) => $.count('[data-testid="assistant-reply"]') === 1);
    // No step: the item is as saved, and there is nothing to step through.
    expect(await cdp.evaluate(exists, 'step-control')).toBe(false);
    expect(await cdp.evaluate(cardTime)).toBe('15:00–16:00');
    await cdp.clickButtonWithText('Save');
    await cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));
    const updates = (await readPendingOps(app.userDataDir)).filter(
      (op) => op.kind === 'update' && op.eventId === 'evt-review',
    );
    expect(updates).toEqual([]);
  });
});
