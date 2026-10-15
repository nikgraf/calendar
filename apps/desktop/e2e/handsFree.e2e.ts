import { Account, CalendarInfo } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, DICTATION_LOOP_MS, launchApp } from './harness.ts';

// Hands-free dictation: one click of the microphone, then every pause
// sends the phrase and it listens again. The microphone is the harness's
// fixture — a looping file of a phrase-long tone between stretches of
// quiet room — so the renderer's real recording and pause detection run
// on known audio; each transcription answers the next phrase below, in
// the fixture model's grammar (`Title | +N | HH:MM-HH:MM`, empty parts
// in a change meaning "unchanged").
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
      colorHex: '#3b82f6',
      id: 'cal-e2e',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'Work',
      timeZone: 'Europe/Vienna',
    }),
  ],
  events: [],
};
const PHRASES = ['Dinner | +2 | 19:00-20:00', '| | 20:00-21:00', '| | 21:00-22:00'];

// CDP key events don't carry macOS meta reliably: dispatch ⌘N to the app's own window listener.
const COMMAND_N = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }))`;
const TITLE = 'input[placeholder="Title"]';
const START = 'input[aria-label="Start time"]';
const titleValue = `document.querySelector(${JSON.stringify(TITLE)})?.value ?? ''`;
// Two turns are listed, newest first; a third folds the oldest into "+1 earlier query".
const turns = `document.querySelectorAll('[data-testid="draft-turn"]').length`;
const newestSummary = `document.querySelector('[data-testid="draft-turn-summary"]')?.textContent ?? ''`;
const startIs = (time: string) =>
  `document.querySelector(${JSON.stringify(START)})?.value === ${JSON.stringify(time)}`;
const MIC = `document.querySelector('[data-testid="quick-add-mic"]')`;
const dictating = `${MIC}?.getAttribute('aria-pressed') === 'true'`;
/** Long enough for the fixture microphone to say one more phrase and pause after it. */
const ONE_LOOP_MS =
  DICTATION_LOOP_MS.quietBefore + DICTATION_LOOP_MS.phrase + DICTATION_LOOP_MS.quietAfter + 1000;

describe('Hands-free dictation', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { microphone: { phrases: PHRASES }, model: 'fixture' });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  it('sends each phrase at its pause and listens on, until the form is edited by hand', async () => {
    const { cdp } = app;
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(
      `document.querySelector('[data-testid="editor-title"]')?.textContent === 'New event'`,
    );

    // One click: the first phrase makes the draft, the second moves it — no click between.
    await cdp.clickTestId('quick-add-mic');
    await cdp.waitFor(`${turns} === 1`, 20_000);
    await cdp.waitFor(startIs('19:00'));
    expect(await cdp.eval<boolean>(dictating)).toBe(true);
    await cdp.waitFor(`${turns} === 2`, 20_000);
    await cdp.waitFor(startIs('20:00'));
    expect(await cdp.eval<boolean>(dictating)).toBe(true);

    // A hand edit — the title typed over: dictation hands over, and nothing more is sent.
    await cdp.eval(`document.querySelector(${JSON.stringify(TITLE)}).select()`);
    await cdp.type(TITLE, 'Late dinner');
    await cdp.waitFor(`!(${dictating})`);
    expect(await cdp.eval<string>(titleValue)).toBe('Late dinner');
    await new Promise((resolve) => setTimeout(resolve, ONE_LOOP_MS));
    expect(await cdp.eval<number>(turns)).toBe(2);
    expect(await cdp.eval<boolean>(startIs('20:00'))).toBe(true);

    // On again: the next phrase changes the time and keeps the title typed meanwhile.
    await cdp.clickTestId('quick-add-mic');
    await cdp.waitFor(`(${newestSummary}).includes('21:00')`, 20_000);
    await cdp.waitFor(startIs('21:00'));
    expect(await cdp.eval<string>(titleValue)).toBe('Late dinner');

    // The microphone ends it.
    await cdp.waitFor(dictating);
    await cdp.clickTestId('quick-add-mic');
    await cdp.waitFor(`!(${dictating})`);
  }, 90_000);
});
