import {
  Account,
  CalendarInfo,
  LESSON_CREATE_PHRASE,
  LESSON_SEARCH_PHRASE,
  type OnboardingState,
} from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readAccounts, readDeviceSetting } from './harness.ts';

const onboarding = (app: App) =>
  readDeviceSetting(app.userDataDir, 'onboarding') as Promise<OnboardingState | null>;

const step = (cdp: App['cdp']) =>
  cdp.evaluate(($) => $.el('[data-testid="setup-dialog"]')?.dataset.step ?? null);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The fake Google API with no account yet: the setup's sign-in adds this one. */
const googleFixture = {
  accounts: [],
  calendars: [
    {
      accessRole: 'owner',
      backgroundColor: '#4285f4',
      id: 'setup-calendar',
      primary: true,
      summary: 'Setup Calendar',
    },
  ],
  signIn: { displayName: 'Setup Person', email: 'setup@example.com' },
};

describe('first run: the setup dialog, the Getting started card and its lessons', () => {
  let app: App;

  beforeAll(async () => {
    app = await launchApp(undefined, {
      google: { fixture: googleFixture },
      model: 'fixture',
      onboarding: 'on',
    });
  });

  afterAll(async () => {
    await app?.stop();
  });

  it('opens on a fresh profile and walks Welcome, the sources, Google and Apple Calendar', async () => {
    const { cdp } = app;
    await cdp.waitUntil(($) => $.el('[data-testid="setup-dialog"]')?.dataset.step === 'welcome');
    await cdp.clickTestId('setup-start');
    await cdp.waitUntil(($) => $.el('[data-testid="setup-dialog"]')?.dataset.step === 'sources');
    // The button that had focus went with Welcome: focus stays on the
    // dialog itself, not on Skip, where the next Enter would end the setup.
    await cdp.waitUntil(
      ($) =>
        document.activeElement?.getAttribute('role') === 'dialog' &&
        document.activeElement.contains($.el('[data-testid="setup-dialog"]')),
    );
    // Google Calendar without Tasks: the sign-in leaves the tasks scope out.
    await cdp.clickTestId('setup-source-googleTasks');
    await cdp.waitUntil(
      ($) => $.el<HTMLInputElement>('[data-testid="setup-source-googleTasks"]')?.checked === false,
    );
    await cdp.clickTestId('setup-continue');
    await cdp.waitUntil(($) => $.el('[data-testid="setup-dialog"]')?.dataset.step === 'google');
    expect(
      await cdp.evaluate(($) => $.el('[data-testid="setup-dialog"]')!.textContent),
    ).not.toContain('Tasks beside your events');

    await cdp.clickTestId('setup-add-google');
    await cdp.waitUntil(($) =>
      $.all('[data-testid^="setup-account-"]').some((row) =>
        row.textContent.includes('setup@example.com'),
      ),
    );
    const google = (await readAccounts(app.userDataDir)).filter(
      (account) => account.provider === 'google',
    );
    expect(google).toHaveLength(1);
    expect(google[0]?.email).toBe('setup@example.com');
    expect(google[0]?.tasksEnabled).toBe(false);

    // Apple Calendar is off in e2e: the step says so and offers Continue only.
    await cdp.clickTestId('setup-continue');
    await cdp.waitUntil(
      ($) => $.el('[data-testid="setup-dialog"]')?.dataset.step === 'appleCalendar',
    );
    await cdp.waitUntil(
      ($) => $.el('[data-testid="setup-apple-note"]')?.textContent.includes('Unavailable') === true,
    );
    expect(await cdp.evaluate(($) => $.has('[data-testid="setup-allow-calendar"]'))).toBe(false);
    await cdp.clickTestId('setup-continue');
    await cdp.waitUntil(($) => !$.has('[data-testid="setup-dialog"]'));
    await expect.poll(async () => (await onboarding(app))?.setup).toBe('done');

    // The card is in the sidebar; with an account there is no "Add your accounts" row.
    await cdp.waitUntil(($) => $.has('[data-testid="getting-started"]'));
    expect(
      await cdp.evaluate(($) =>
        $.all('[data-testid^="getting-started-row-"]').map((row) =>
          row.dataset.testid!.slice('getting-started-row-'.length),
        ),
      ),
    ).toEqual(['create', 'search', 'alerts', 'contacts', 'zones', 'otherDevice']);
  });

  it('opens Create with AI as the editor with the phrase in its field, and ticks it once a phrase lands', async () => {
    const { cdp } = app;
    await cdp.clickTestId('getting-started-row-create');
    await cdp.waitUntil(($) => $.el('[data-testid="lesson-banner"]')?.dataset.lesson === 'create');
    expect(
      await cdp.evaluate(($) => $.el<HTMLInputElement>('[data-testid="quick-add-input"]')!.value),
    ).toBe(LESSON_CREATE_PHRASE);
    // The phrase is in the Assistant's field, selected: Return sends it.
    await cdp.evaluate(($) => {
      $.el('[data-testid="quick-add-input"]')!.focus();
    });
    await cdp.pressEnter();
    await expect
      .poll(async () => (await onboarding(app))?.lessons.create, { timeout: 10_000 })
      .toBe('done');
    // Tried: the hint stays over the draft, but Skip leaves — it would
    // close the editor and lose the draft.
    await cdp.waitUntil(($) => !$.has('[data-testid="lesson-skip"]'));
    expect(await cdp.evaluate(($) => $.has('[data-testid="lesson-banner"]'))).toBe(true);
    // Leaving after a try keeps it done (the try's draft asks first).
    await cdp.clickTestId('editor-close');
    await cdp.answerDiscard(true);
    await cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));
    await sleep(300);
    expect((await onboarding(app))?.lessons.create).toBe('done');
    await cdp.waitUntil(
      ($) => $.el('[data-testid="getting-started-row-create"]')?.dataset.mark === 'done',
    );
  });

  it('opens Search with AI from a fresh thread, its sentence read, and Skip ticks it as skipped', async () => {
    const { cdp } = app;
    // An earlier search left a place filter: the lesson starts without it.
    await cdp.clickTestId('search-toggle');
    await cdp.type('[data-testid="search-input"]', 'lunch | | Hafen');
    await cdp.clickTestId('search-ask');
    await cdp.waitUntil(($) => $.has('[data-testid^="search-chip-location"]'));
    await cdp.clickTestId('search-close');
    await cdp.clickTestId('getting-started-row-search');
    await cdp.waitUntil(($) => $.el('[data-testid="lesson-banner"]')?.dataset.lesson === 'search');
    // The fixture model reads the sentence as a turn of plain words, and
    // the earlier search's place filter is gone.
    await cdp.waitUntil(($) =>
      $.has('[data-testid="search-turn"], [data-testid="search-turn-summary"]'),
    );
    expect(await cdp.evaluate(($) => $.has('[data-testid^="search-chip-location"]'))).toBe(false);
    expect(await cdp.evaluate(($) => $.text('[data-testid="search-turn"]'))).toContain(
      LESSON_SEARCH_PHRASE,
    );
    // Opened again while it is up: the thread starts over, which is not a
    // try — the lesson stays open with its banner.
    await cdp.clickTestId('getting-started-row-search');
    await cdp.waitUntil(($) => $.has('[data-testid="search-turn"]'));
    await sleep(500);
    expect(await cdp.evaluate(($) => $.has('[data-testid="lesson-banner"]'))).toBe(true);
    expect((await onboarding(app))?.lessons.search).toBeUndefined();
    await cdp.clickTestId('lesson-skip');
    await cdp.waitUntil(($) => !$.has('[data-testid="lesson-banner"]'));
    await expect.poll(async () => (await onboarding(app))?.lessons.search).toBe('skipped');
    await cdp.clickTestId('search-close');
  });

  it('frames Alerts and Time zones in the side panel: a change ticks done, Done alone ticks skipped', async () => {
    const { cdp } = app;
    await cdp.clickTestId('getting-started-row-alerts');
    await cdp.waitUntil(($) => $.el('[data-testid="lesson-panel"]')?.dataset.lesson === 'alerts');
    await cdp.evaluate(($) => {
      $.el('input[aria-label="Notify me before events"]')!.click();
    });
    await expect.poll(async () => (await onboarding(app))?.lessons.alerts).toBe('done');
    await cdp.clickTestId('lesson-done');
    await cdp.waitUntil(($) => $.el('[data-testid="panel"]')?.dataset.panelKind !== 'lesson');

    await cdp.clickTestId('getting-started-row-zones');
    await cdp.waitUntil(($) => $.el('[data-testid="lesson-panel"]')?.dataset.lesson === 'zones');
    await cdp.waitUntil(($) => $.has('[data-testid="time-zones"]'));
    await cdp.clickTestId('lesson-done');
    await expect.poll(async () => (await onboarding(app))?.lessons.zones).toBe('skipped');
    await cdp.waitUntil(($) => $.text('[data-testid="getting-started-progress"]') === '4 of 6');
  });

  it('closes only the card menu on Escape, keeping an open editor and its draft', async () => {
    const { cdp } = app;
    const add = await cdp.locate('button[aria-label="New event"]');
    await cdp.click(add.x, add.y);
    await cdp.waitUntil(($) => $.has('input[placeholder="Title"]'));
    await cdp.showEditorView('form');
    await cdp.evaluate(($) => $.setValue('input[placeholder="Title"]', 'Draft under the menu'));
    await cdp.clickTestId('getting-started-more');
    await cdp.waitUntil(($) => $.has('[aria-label="Close menu"]'));
    await cdp.pressEscape();
    await cdp.waitUntil(($) => !$.has('[aria-label="Close menu"]'));
    expect(
      await cdp.evaluate(($) => $.el<HTMLInputElement>('input[placeholder="Title"]')?.value),
    ).toBe('Draft under the menu');
    await cdp.discardEditor();
  });

  it('folds to one line and back, and Hide removes the card', async () => {
    const { cdp } = app;
    await cdp.clickTestId('getting-started-collapse');
    await cdp.waitUntil(
      ($) => $.el('[data-testid="getting-started"]')?.dataset.cardState === 'collapsed',
    );
    await expect.poll(async () => (await onboarding(app))?.card).toBe('collapsed');
    await cdp.clickTestId('getting-started');
    await cdp.waitUntil(
      ($) => $.el('[data-testid="getting-started"]')?.dataset.cardState === 'expanded',
    );
    await cdp.clickTestId('getting-started-more');
    await cdp.clickTestId('getting-started-hide');
    await cdp.waitUntil(($) => !$.has('[data-testid="getting-started"]'));
    await expect.poll(async () => (await onboarding(app))?.card).toBe('hidden');
  });

  it('lists the lessons in Settings › Getting Started, opens one in the calendar, and starts over', async () => {
    const { cdp } = app;
    const settings = await app.openSettings('gettingstarted');
    await settings.waitUntil(
      ($) => $.text('[data-testid="getting-started-count"]') === '4 of 6 done',
    );
    expect(
      await settings.evaluate(
        ($) => $.el<HTMLInputElement>('[data-testid="getting-started-show"]')!.checked,
      ),
    ).toBe(false);
    expect(
      await settings.evaluate(
        ($) => $.el('[data-testid="getting-started-lesson-alerts"]')?.dataset.mark,
      ),
    ).toBe('done');

    // Open hops to the calendar window, which shows the lesson in its panel.
    await settings.clickTestId('getting-started-open-contacts');
    await cdp.waitUntil(($) => $.el('[data-testid="lesson-panel"]')?.dataset.lesson === 'contacts');
    await cdp.clickTestId('lesson-done');
    await expect.poll(async () => (await onboarding(app))?.lessons.contacts).toBe('skipped');

    await settings.clickTestId('getting-started-start-over');
    await expect
      .poll(async () => onboarding(app))
      .toEqual({
        card: 'expanded',
        lessons: {},
        setup: 'done',
      });
    await cdp.waitUntil(($) => $.text('[data-testid="getting-started-progress"]') === '0 of 6');
    await app.closeSettings();
  });
});

describe('first run skipped: the card leads with "Add your accounts"', () => {
  let app: App;

  beforeAll(async () => {
    app = await launchApp(undefined, { onboarding: 'on' });
  });

  afterAll(async () => {
    await app?.stop();
  });

  it('Skip leaves the setup for the card, whose first row opens it on the sources again', async () => {
    const { cdp } = app;
    await cdp.waitUntil(($) => $.el('[data-testid="setup-dialog"]')?.dataset.step === 'welcome');
    await cdp.clickTestId('setup-skip');
    await cdp.waitUntil(($) => !$.has('[data-testid="setup-dialog"]'));
    await expect.poll(async () => (await onboarding(app))?.setup).toBe('skipped');
    await cdp.waitUntil(($) => $.has('[data-testid="getting-started-row-accounts"]'));

    await cdp.clickTestId('getting-started-row-accounts');
    await cdp.waitUntil(($) => $.el('[data-testid="setup-dialog"]')?.dataset.step === 'sources');
    expect(await step(cdp)).toBe('sources');
    // Escape leaves it as before: skipped, the card still there.
    await cdp.pressEscape();
    await cdp.waitUntil(($) => !$.has('[data-testid="setup-dialog"]'));
    expect((await onboarding(app))?.setup).toBe('skipped');
    await cdp.waitUntil(($) => $.has('[data-testid="getting-started-row-accounts"]'));
  });
});

describe('onboarding stays away where it does not belong', () => {
  let app: App;
  let off: App;

  beforeAll(async () => {
    const account = new Account({
      contactsEnabled: false,
      createdAt: 1,
      email: 'seeded@example.com',
      id: 'acc-seeded',
      provider: 'google',
      status: 'ok',
      tasksEnabled: false,
    });
    const calendar = new CalendarInfo({
      accessRole: 'owner',
      accountId: 'acc-seeded',
      colorHex: '#3b82f6',
      id: 'cal-seeded',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'Seeded',
      timeZone: 'UTC',
    });
    [app, off] = await Promise.all([
      launchApp({ accounts: [account], calendars: [calendar], events: [] }, { onboarding: 'on' }),
      // The harness's default: CALENDAR_ONBOARDING=off, on an empty profile.
      launchApp(),
    ]);
  });

  afterAll(async () => {
    await Promise.all([app?.stop(), off?.stop()]);
  });

  it('a profile with an account shows the card but never the setup', async () => {
    await app.cdp.waitUntil(($) => $.has('[data-testid="getting-started"]'));
    await sleep(1000);
    expect(await app.cdp.evaluate(($) => $.has('[data-testid="setup-dialog"]'))).toBe(false);
    expect(
      await app.cdp.evaluate(($) => $.has('[data-testid="getting-started-row-accounts"]')),
    ).toBe(false);
  });

  it('CALENDAR_ONBOARDING=off shows neither on an empty profile', async () => {
    await off.cdp.waitUntil(($) => $.has('[data-testid="sidebar"]'));
    await sleep(1500);
    expect(
      await off.cdp.evaluate(($) =>
        $.has('[data-testid="setup-dialog"], [data-testid="getting-started"]'),
      ),
    ).toBe(false);
    expect(await onboarding(off)).toBeNull();
  });
});

describe('Create with AI before the Assistant’s model is here: the demo, and the download offered', () => {
  let app: App;
  // The model not asked for yet: a manifest nothing fetches before
  // Download, and whose host then refuses (the download fails).
  const manifest = JSON.stringify({
    bytes: 10,
    file: 'e2e.gguf',
    sha256: '0'.repeat(64),
    url: 'http://127.0.0.1:9/e2e.gguf',
    version: 'e2e-1',
  });

  beforeAll(async () => {
    // An account already there: no setup, the card at once.
    app = await launchApp(
      {
        accounts: [
          new Account({
            contactsEnabled: false,
            createdAt: 1,
            email: 'demo@example.com',
            id: 'acc-demo',
            provider: 'google',
            status: 'ok',
            tasksEnabled: false,
          }),
        ],
        calendars: [
          new CalendarInfo({
            accessRole: 'owner',
            accountId: 'acc-demo',
            colorHex: '#16a34a',
            id: 'cal-demo',
            isPrimary: true,
            isVisible: true,
            provider: 'google',
            summary: 'Personal',
            timeZone: 'Europe/Vienna',
          }),
        ],
        events: [],
      },
      {
        // A stand-in for llama-server, which CI's build has none of: never
        // started, since the download fails before there is a model to run.
        assistantModel: { llamaServer: '/usr/bin/true', manifest },
        onboarding: 'on',
      },
    );
  });

  afterAll(async () => {
    await app?.stop();
  });

  it('runs the lesson’s two phrases on the real editor, then offers the model and says when its download failed', async () => {
    const { cdp } = app;
    await cdp.waitUntil(
      ($) =>
        $.text('[data-testid="getting-started-subtitle-create"]') ===
        'Try the demo · the Assistant downloads once',
    );
    await cdp.clickTestId('getting-started-row-create');
    await cdp.waitUntil(($) => $.el('[data-testid="lesson-banner"]')?.dataset.lesson === 'create');
    // The banner says what the Assistant is and offers its download; the
    // editor stays on the Assistant, its field holding the lesson's phrase.
    expect(await cdp.evaluate(($) => $.text('[data-testid="lesson-banner-note"]'))).toContain(
      'The Assistant reads what you say only with models on this Mac, never with an AI in the cloud.',
    );
    expect(await cdp.evaluate(($) => $.text('[data-testid="lesson-model-action"]'))).toBe(
      'Download (834 MB)',
    );
    expect(await cdp.evaluate(($) => $.el('[data-testid="editor"]')!.dataset.view)).toBe(
      'assistant',
    );
    expect(await cdp.evaluate(($) => $.has('[data-testid="assistant-demo-empty"]'))).toBe(true);
    expect(
      await cdp.evaluate(($) => $.el<HTMLInputElement>('[data-testid="quick-add-input"]')!.value),
    ).toBe(LESSON_CREATE_PHRASE);
    expect(
      await cdp.evaluate(
        ($) => $.el<HTMLInputElement>('[data-testid="quick-add-input"]')!.readOnly,
      ),
    ).toBe(true);
    expect(await cdp.evaluate(($) => $.text('[data-testid="quick-add-status"]'))).toBe(
      'Demo · this phrase',
    );

    // The phrase: the real card, from the demo's answer — and the lesson tried.
    await cdp.clickTestId('quick-add-demo-send');
    await cdp.waitUntil(
      { timeoutMs: 10_000 },
      ($) => $.text('[data-testid="assistant-card-title"]') === 'Lunch with Sam',
    );
    expect(await cdp.evaluate(($) => $.text('[data-testid="assistant-card-time"]'))).toBe(
      '12:30–13:30',
    );
    expect(await cdp.evaluate(($) => $.text('[data-testid="assistant-card-location"]'))).toBe(
      'Mercato',
    );
    expect(await cdp.evaluate(($) => $.has('[data-testid="assistant-demo-note"]'))).toBe(true);
    await expect
      .poll(async () => (await onboarding(app))?.lessons.create, { timeout: 10_000 })
      .toBe('done');

    // Then its change, as a step of its own.
    await cdp.waitUntil(
      ($) => $.el<HTMLInputElement>('[data-testid="quick-add-input"]')!.value === 'at 1 instead',
    );
    expect(await cdp.evaluate(($) => $.text('[data-testid="quick-add-status"]'))).toBe(
      'Demo · now a change to it',
    );
    await cdp.clickTestId('quick-add-demo-send');
    await cdp.waitUntil(
      { timeoutMs: 10_000 },
      ($) => $.text('[data-testid="assistant-card-time"]') === '13:00–14:0012:30–13:30',
    );
    expect(await cdp.evaluate(($) => $.text('[data-testid="assistant-changed"]'))).toBe(
      'Changed: time',
    );

    // Through: the field waits for the model.
    await cdp.waitUntil(($) => $.el<HTMLInputElement>('[data-testid="quick-add-input"]')!.disabled);
    expect(
      await cdp.evaluate(
        ($) => $.el<HTMLInputElement>('[data-testid="quick-add-input"]')!.placeholder,
      ),
    ).toBe('Your own words once the model is here');

    // The download, asked for from the banner: this host refuses, and the
    // banner says so and offers it again (the card's row is ticked by now).
    await cdp.clickTestId('lesson-model-action');
    await cdp.waitUntil(
      { timeoutMs: 10_000 },
      ($) => $.text('[data-testid="lesson-model-action"]') === 'Try Again',
    );
    expect(await cdp.evaluate(($) => $.text('[data-testid="lesson-banner-note"]'))).toContain(
      'The download of the Assistant’s model did not finish',
    );
  });
});
