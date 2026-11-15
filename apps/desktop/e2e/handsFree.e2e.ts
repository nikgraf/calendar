import { Account, CalendarInfo } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, DICTATION_LOOP_MS, launchApp } from './harness.ts';

// Hands-free dictation: one click of the microphone, then every phrase
// is sent when its words stop and it listens again. The microphone is the
// harness's fixture — a looping file of a phrase-long tone between
// stretches of quiet room — so the renderer's real streaming and the rule
// that ends a phrase on its words run on known audio; the tone writes the
// next phrase below word by word, and each reading answers it, in
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
// What the Assistant's conversation holds: a line per phrase taken, and the newest card's hours.
const said = `document.querySelectorAll('[data-testid="assistant-said"]').length`;
const cardTime = `(document.querySelector('[data-testid="assistant-card-time"]')?.textContent ?? '')`;
const startIs = (time: string) =>
  `document.querySelector(${JSON.stringify(START)})?.value === ${JSON.stringify(time)}`;
const MIC = `document.querySelector('[data-testid="quick-add-mic"]')`;
const dictating = `${MIC}?.getAttribute('aria-pressed') === 'true'`;
/** The words of the phrase being said, while it is: nothing once it is sent. */
const listeningTo = `(${MIC}?.dataset.listening === 'speech' ? (document.querySelector('[data-testid="assistant-pending"]')?.textContent ?? '') : '')`;
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
    // Its words show in the thread while it is said, before it is sent.
    await cdp.waitFor(`${listeningTo}.startsWith('Dinner')`, 20_000);
    await cdp.waitFor(`(${titleValue}) === 'Dinner'`, 20_000);
    await cdp.waitFor(startIs('19:00'));
    expect(await cdp.eval<boolean>(dictating)).toBe(true);
    await cdp.waitFor(`${said} === 2`, 20_000);
    await cdp.waitFor(startIs('20:00'));
    expect(await cdp.eval<boolean>(dictating)).toBe(true);

    // The form brought forward does not end it; a hand edit there — the
    // title typed over — does: dictation hands over, and nothing more is sent.
    await cdp.showEditorView('form');
    expect(await cdp.eval<boolean>(dictating)).toBe(true);
    await cdp.eval(`document.querySelector(${JSON.stringify(TITLE)}).select()`);
    await cdp.type(TITLE, 'Late dinner');
    await cdp.waitFor(`!(${dictating})`);
    expect(await cdp.eval<string>(titleValue)).toBe('Late dinner');
    await new Promise((resolve) => setTimeout(resolve, ONE_LOOP_MS));
    expect(await cdp.eval<number>(said)).toBe(2);
    expect(await cdp.eval<boolean>(startIs('20:00'))).toBe(true);

    // On again, in the Assistant: the next phrase changes the time and keeps the title typed meanwhile.
    await cdp.showEditorView('assistant');
    await cdp.clickTestId('quick-add-mic');
    await cdp.waitFor(`${cardTime}.includes('21:00')`, 20_000);
    await cdp.waitFor(startIs('21:00'));
    expect(await cdp.eval<string>(titleValue)).toBe('Late dinner');

    // An older step put on show ends it too: there is nothing to say a
    // phrase to, and the microphone must not stay open behind a control
    // that is off.
    await cdp.waitFor(dictating);
    await cdp.clickTestId('assistant-undo');
    await cdp.waitFor(`!(${dictating})`);
    await cdp.clickTestId('step-forward');
    await cdp.waitFor(`!document.querySelector('[data-testid="step-preview"]')`);

    // The microphone ends it.
    await cdp.clickTestId('quick-add-mic');
    await cdp.waitFor(dictating);
    await cdp.clickTestId('quick-add-mic');
    await cdp.waitFor(`!(${dictating})`);
  }, 90_000);

  it('reduces background noise until Settings › Dictation turns it off, for both windows', async () => {
    const settings = await app.openSettings('dictation');
    const box = `document.querySelector('[data-testid="reduce-background-noise"]')`;
    // From nothing chosen, also on a retry: the calendar window clears the
    // choice and the Settings window hears of it (a `storage` event).
    await app.cdp.eval(`localStorage.removeItem('dictation.reduceNoise')`);
    await settings.waitFor(`${box}?.checked === true`);
    expect(
      await settings.eval<string>(
        `document.querySelector('[data-testid="dictation-language"]')?.textContent ?? ''`,
      ),
    ).toContain('this Mac’s language');
    await settings.eval(`${box}.click()`);
    await settings.waitFor(`${box}.checked === false`);
    // The calendar window opens the microphone: the choice reaches it.
    await app.cdp.waitFor(`localStorage.getItem('dictation.reduceNoise') === 'off'`);
  });
});
