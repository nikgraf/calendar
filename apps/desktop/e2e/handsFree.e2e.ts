import { Account, CalendarInfo } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, DICTATION_LOOP_MS, DICTATION_TONE_MS, launchApp } from './harness.ts';
import type { PageKit } from './page.ts';

// Hands-free dictation: one click of the microphone, then every phrase
// is sent when its words stop, the microphone open throughout; words said
// while a phrase is read join it, and a hold listens through any pause
// until it is let go of. The microphone is the
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
const commandN = () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }));
};
const TITLE = 'input[placeholder="Title"]';
const START = 'input[aria-label="Start time"]';
const titleValue = ($: PageKit, title: string) => $.value(title);
// What the Assistant's conversation holds: a line per phrase taken.
const said = ($: PageKit) => $.count('[data-testid="assistant-said"]');
const startIs = ($: PageKit, start: string, time: string) => $.value(start) === time;
const dictating = ($: PageKit) =>
  $.el('[data-testid="quick-add-mic"]')?.getAttribute('aria-pressed') === 'true';
/**
 * The words of the phrase being said, while it is (nothing once it is
 * sent), begin with `words`.
 */
const listeningStartsWith = ($: PageKit, words: string) =>
  ($.el('[data-testid="quick-add-mic"]')?.dataset.listening === 'speech'
    ? $.text('[data-testid="assistant-pending"]')
    : ''
  ).startsWith(words);
/** How often the page opened its microphone. */
const microphoneOpens = ($: PageKit) => Number($.el('html')?.dataset.microphoneOpens ?? '0');
/** Long enough for the fixture microphone to say one more phrase and pause after it. */
const ONE_LOOP_MS =
  DICTATION_LOOP_MS.quietBefore + DICTATION_LOOP_MS.phrase + DICTATION_LOOP_MS.quietAfter + 1000;

describe('Hands-free dictation', () => {
  let app: App;
  beforeAll(async () => {
    // A reading takes about a second, as the helper's does.
    app = await launchApp(seed, {
      microphone: { phrases: PHRASES, readMs: 1000 },
      model: 'fixture',
    });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  it('sends each phrase at its pause and listens on, until the form is edited by hand', async () => {
    const { cdp } = app;
    await cdp.evaluate(commandN);
    await cdp.waitUntil(($) => $.text('[data-testid="editor-title"]') === 'New event');

    // One click: the first phrase makes the draft, the second moves it — no click between.
    await cdp.clickTestId('quick-add-mic');
    // Its words show in the thread while it is said, before it is sent.
    await cdp.waitUntil({ timeoutMs: 20_000 }, listeningStartsWith, 'Dinner');
    await cdp.waitUntil(
      { timeoutMs: 20_000 },
      ($, title: string) => $.value(title) === 'Dinner',
      TITLE,
    );
    await cdp.waitUntil(startIs, START, '19:00');
    expect(await cdp.evaluate(dictating)).toBe(true);
    await cdp.waitUntil(
      { timeoutMs: 20_000 },
      ($) => $.count('[data-testid="assistant-said"]') === 2,
    );
    await cdp.waitUntil(startIs, START, '20:00');
    expect(await cdp.evaluate(dictating)).toBe(true);
    // One microphone for both phrases: it stayed open while each was read.
    expect(await cdp.evaluate(microphoneOpens)).toBe(1);

    // The form brought forward does not end it; a hand edit there — the
    // title typed over — does: dictation hands over, and nothing more is sent.
    await cdp.showEditorView('form');
    expect(await cdp.evaluate(dictating)).toBe(true);
    await cdp.evaluate(($, title: string) => {
      $.el<HTMLInputElement>(title)!.select();
    }, TITLE);
    await cdp.type(TITLE, 'Late dinner');
    await cdp.waitUntil(
      ($) => $.el('[data-testid="quick-add-mic"]')?.getAttribute('aria-pressed') !== 'true',
    );
    expect(await cdp.evaluate(titleValue, TITLE)).toBe('Late dinner');
    await new Promise((resolve) => setTimeout(resolve, ONE_LOOP_MS));
    expect(await cdp.evaluate(said)).toBe(2);
    expect(await cdp.evaluate(startIs, START, '20:00')).toBe(true);

    // On again, in the Assistant: the next phrase changes the time and keeps the title typed meanwhile.
    await cdp.showEditorView('assistant');
    await cdp.clickTestId('quick-add-mic');
    await cdp.waitUntil({ timeoutMs: 20_000 }, ($) =>
      $.text('[data-testid="assistant-card-time"]').includes('21:00'),
    );
    await cdp.waitUntil(startIs, START, '21:00');
    expect(await cdp.evaluate(titleValue, TITLE)).toBe('Late dinner');

    // An older step put on show ends it too: there is nothing to say a
    // phrase to, and the microphone must not stay open behind a control
    // that is off.
    await cdp.waitUntil(dictating);
    await cdp.clickTestId('assistant-undo');
    await cdp.waitUntil(
      ($) => $.el('[data-testid="quick-add-mic"]')?.getAttribute('aria-pressed') !== 'true',
    );
    await cdp.clickTestId('step-forward');
    await cdp.waitUntil(($) => !$.has('[data-testid="step-preview"]'));

    // The microphone ends it.
    await cdp.clickTestId('quick-add-mic');
    await cdp.waitUntil(dictating);
    await cdp.clickTestId('quick-add-mic');
    await cdp.waitUntil(
      ($) => $.el('[data-testid="quick-add-mic"]')?.getAttribute('aria-pressed') !== 'true',
    );
  }, 90_000);

  it('reduces background noise until Settings › Dictation turns it off, for both windows', async () => {
    const settings = await app.openSettings('dictation');
    const box = '[data-testid="reduce-background-noise"]';
    // From nothing chosen, also on a retry: the calendar window clears the
    // choice and the Settings window hears of it (a `storage` event).
    await app.cdp.evaluate(() => {
      localStorage.removeItem('dictation.reduceNoise');
    });
    await settings.waitUntil(
      ($, checkbox: string) => $.el<HTMLInputElement>(checkbox)?.checked === true,
      box,
    );
    expect(await settings.evaluate(($) => $.text('[data-testid="dictation-language"]'))).toContain(
      'this Mac’s language',
    );
    await settings.evaluate(($, checkbox: string) => {
      $.el(checkbox)!.click();
    }, box);
    await settings.waitUntil(
      ($, checkbox: string) => $.el<HTMLInputElement>(checkbox)!.checked === false,
      box,
    );
    // The calendar window opens the microphone: the choice reaches it.
    await app.cdp.waitUntil(() => localStorage.getItem('dictation.reduceNoise') === 'off');
  });

  it('picks the language and the second language in Settings › Dictation, Automatic until then', async () => {
    const settings = await app.openSettings('dictation');
    const language = '[data-testid="dictation-language-select"]';
    const second = '[data-testid="dictation-second-language-select"]';
    // From nothing chosen, also on a retry (see above).
    await app.cdp.evaluate(() => {
      localStorage.removeItem('dictation.language');
      localStorage.removeItem('dictation.secondLanguage');
    });
    // Both read Automatic once the Settings window has heard of it, and the
    // fixture's recogniser lists five languages (`fixtureLanguages`).
    await settings.waitUntil(
      ($, selects: ReadonlyArray<string>) =>
        selects.every((select) => $.value(select) === 'auto') &&
        $.all(`${selects[1]!} option`).length > 2,
      [language, second],
    );
    const secondChoices = () =>
      settings.evaluate(
        ($, select: string) =>
          $.all<HTMLOptionElement>(`${select} option`).map((option) => option.value),
        second,
      );
    await settings.evaluate(($, select: string) => $.setValue(select, 'en-GB'), language);
    // Listening in English, Automatic's second is German, and English leaves its list.
    await settings.waitUntil(
      ($, select: string) => $.text(`${select} option`) === 'Automatic — German (Austria)',
      second,
    );
    expect(await secondChoices()).toEqual(['auto', 'off', 'fr-FR', 'de-AT', 'de-DE']);
    await settings.evaluate(($, select: string) => $.setValue(select, 'de-DE'), language);
    // Listening in German, the other way round.
    await settings.waitUntil(
      ($, select: string) => $.text(`${select} option`) === 'Automatic — English (United States)',
      second,
    );
    expect(await secondChoices()).toEqual(['auto', 'off', 'en-GB', 'en-US', 'fr-FR']);
    await settings.evaluate(($, select: string) => $.setValue(select, 'off'), second);
    // The calendar window reads both at its next phrase.
    await app.cdp.waitUntil(
      () =>
        localStorage.getItem('dictation.language') === 'de-DE' &&
        localStorage.getItem('dictation.secondLanguage') === 'off',
    );
  });
});

// Keep listening: a phrase, a pause long enough to end it, the phrase
// going on before its reading (1.5 s here) is back, then a long quiet.
const GROW_LOOP = [800, DICTATION_TONE_MS, 1300, DICTATION_TONE_MS, 4000];
// Hold to talk: the same, with a pause long enough for the first half to
// be read and land (0.9 s pause + 1.5 s reading) were it not held.
const HOLD_LOOP = [800, DICTATION_TONE_MS, 3500, DICTATION_TONE_MS, 6000];
const SPLIT_PHRASES = ['Dinner', '| +2 | 19:00-20:00'];

const openNewEvent = async (app: App) => {
  await app.cdp.evaluate(commandN);
  await app.cdp.waitUntil(($) => $.text('[data-testid="editor-title"]') === 'New event');
};
const micOff = ($: PageKit) =>
  !$.el('[data-testid="quick-add-mic"]')?.matches('[aria-pressed="true"]');

describe('Keep listening', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, {
      microphone: { loop: GROW_LOOP, phrases: SPLIT_PHRASES, readMs: 1500 },
      model: 'fixture',
    });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  it('words said while a phrase is read join it, and the grown phrase is read instead', async () => {
    const { cdp } = app;
    await openNewEvent(app);
    await cdp.clickTestId('quick-add-mic');
    // "Dinner", a pause that sends it, then the rest before it landed: one turn.
    await cdp.waitUntil(
      { timeoutMs: 20_000 },
      ($) => $.count('[data-testid="assistant-said"]') >= 1,
    );
    await cdp.waitUntil(startIs, START, '19:00');
    expect(await cdp.evaluate(titleValue, TITLE)).toBe('Dinner');
    expect(await cdp.evaluate(said)).toBe(1);
    expect(await cdp.evaluate(dictating)).toBe(true);
    // Done: the click sends nothing more (nothing was said since).
    await cdp.clickTestId('quick-add-mic');
    await cdp.waitUntil(micOff);
    // The microphone read to the end once more, and found nothing to send.
    await cdp.waitUntil(($) => $.text('[data-testid="quick-add-status"]') === '');
    expect(await cdp.evaluate(said)).toBe(1);
  }, 60_000);
});

describe('Hold to talk', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, {
      microphone: { loop: HOLD_LOOP, phrases: SPLIT_PHRASES, readMs: 1500 },
      model: 'fixture',
    });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  it('held, it listens through a pause and sends when let go of', async () => {
    const { cdp } = app;
    await openNewEvent(app);
    const mic = await cdp.locate('[data-testid="quick-add-mic"]');
    await cdp.mouse('mousePressed', mic.x, mic.y);
    await cdp.waitUntil(
      ($) => $.text('[data-testid="quick-add-status"]') === 'Holding… release to send',
    );
    // Both halves heard, past the pause between them that would have sent
    // the first: nothing sent while held.
    await cdp.waitUntil({ timeoutMs: 20_000 }, ($) =>
      $.text('[data-testid="assistant-pending"]').includes('19:00-20:00'),
    );
    expect(await cdp.evaluate(($) => $.text('[data-testid="assistant-pending"]'))).toContain(
      'Dinner',
    );
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await cdp.evaluate(said)).toBe(0);
    expect(
      await cdp.evaluate(($) =>
        $.el('[data-testid="quick-add-mic"]')?.getAttribute('data-holding'),
      ),
    ).toBe('true');

    await cdp.mouse('mouseReleased', mic.x, mic.y);
    await cdp.waitUntil(
      { timeoutMs: 20_000 },
      ($) => $.count('[data-testid="assistant-said"]') === 1,
    );
    await cdp.waitUntil(startIs, START, '19:00');
    expect(await cdp.evaluate(titleValue, TITLE)).toBe('Dinner');
    // Let go of, it listens no further.
    await cdp.waitUntil(micOff);
    expect(await cdp.evaluate(said)).toBe(1);
  }, 60_000);
});
