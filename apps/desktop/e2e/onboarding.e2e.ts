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
  cdp.eval<string | null>(
    `document.querySelector('[data-testid="setup-dialog"]')?.dataset.step ?? null`,
  );

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
    await cdp.waitFor(
      `document.querySelector('[data-testid="setup-dialog"]')?.dataset.step === 'welcome'`,
    );
    await cdp.clickTestId('setup-start');
    await cdp.waitFor(
      `document.querySelector('[data-testid="setup-dialog"]')?.dataset.step === 'sources'`,
    );
    // Google Calendar without Tasks: the sign-in leaves the tasks scope out.
    await cdp.clickTestId('setup-source-googleTasks');
    await cdp.waitFor(
      `document.querySelector('[data-testid="setup-source-googleTasks"]')?.checked === false`,
    );
    await cdp.clickTestId('setup-continue');
    await cdp.waitFor(
      `document.querySelector('[data-testid="setup-dialog"]')?.dataset.step === 'google'`,
    );
    expect(
      await cdp.eval<string>(`document.querySelector('[data-testid="setup-dialog"]').textContent`),
    ).not.toContain('Tasks beside your events');

    await cdp.clickTestId('setup-add-google');
    await cdp.waitFor(
      `[...document.querySelectorAll('[data-testid^="setup-account-"]')].some((row) => row.textContent.includes('setup@example.com'))`,
    );
    const google = (await readAccounts(app.userDataDir)).filter(
      (account) => account.provider === 'google',
    );
    expect(google).toHaveLength(1);
    expect(google[0]?.email).toBe('setup@example.com');
    expect(google[0]?.tasksEnabled).toBe(false);

    // Apple Calendar is off in e2e: the step says so and offers Continue only.
    await cdp.clickTestId('setup-continue');
    await cdp.waitFor(
      `document.querySelector('[data-testid="setup-dialog"]')?.dataset.step === 'appleCalendar'`,
    );
    await cdp.waitFor(
      `document.querySelector('[data-testid="setup-apple-note"]')?.textContent.includes('Unavailable')`,
    );
    expect(await cdp.eval(`!!document.querySelector('[data-testid="setup-allow-calendar"]')`)).toBe(
      false,
    );
    await cdp.clickTestId('setup-continue');
    await cdp.waitFor(`!document.querySelector('[data-testid="setup-dialog"]')`);
    await expect.poll(async () => (await onboarding(app))?.setup).toBe('done');

    // The card is in the sidebar; with an account there is no "Add your accounts" row.
    await cdp.waitFor(`!!document.querySelector('[data-testid="getting-started"]')`);
    expect(
      await cdp.eval<Array<string>>(
        `[...document.querySelectorAll('[data-testid^="getting-started-row-"]')].map((row) => row.dataset.testid.slice('getting-started-row-'.length))`,
      ),
    ).toEqual(['create', 'search', 'alerts', 'contacts', 'zones', 'otherDevice']);
  });

  it('opens Create with AI as the editor with the phrase in its field, and ticks it once a phrase lands', async () => {
    const { cdp } = app;
    await cdp.clickTestId('getting-started-row-create');
    await cdp.waitFor(
      `document.querySelector('[data-testid="lesson-banner"]')?.dataset.lesson === 'create'`,
    );
    expect(
      await cdp.eval<string>(`document.querySelector('[data-testid="quick-add-input"]').value`),
    ).toBe(LESSON_CREATE_PHRASE);
    await cdp.clickTestId('quick-add-apply');
    await expect
      .poll(async () => (await onboarding(app))?.lessons.create, { timeout: 10_000 })
      .toBe('done');
    // Leaving after a try keeps it done.
    await cdp.clickTestId('editor-close');
    await cdp.waitFor(`!document.querySelector('[data-testid="editor"]')`);
    await sleep(300);
    expect((await onboarding(app))?.lessons.create).toBe('done');
    await cdp.waitFor(
      `document.querySelector('[data-testid="getting-started-row-create"]')?.dataset.mark === 'done'`,
    );
  });

  it('opens Search with AI with its sentence read, and Skip ticks it as skipped', async () => {
    const { cdp } = app;
    await cdp.clickTestId('getting-started-row-search');
    await cdp.waitFor(
      `document.querySelector('[data-testid="lesson-banner"]')?.dataset.lesson === 'search'`,
    );
    // The fixture model reads the sentence as a turn of plain words.
    await cdp.waitFor(
      `!!document.querySelector('[data-testid="search-turn"], [data-testid="search-turn-summary"]')`,
    );
    expect(LESSON_SEARCH_PHRASE.length).toBeGreaterThan(0);
    await cdp.clickTestId('lesson-skip');
    await cdp.waitFor(`!document.querySelector('[data-testid="lesson-banner"]')`);
    await expect.poll(async () => (await onboarding(app))?.lessons.search).toBe('skipped');
    await cdp.clickTestId('search-close');
  });

  it('frames Alerts and Time zones in the side panel: a change ticks done, Done alone ticks skipped', async () => {
    const { cdp } = app;
    await cdp.clickTestId('getting-started-row-alerts');
    await cdp.waitFor(
      `document.querySelector('[data-testid="lesson-panel"]')?.dataset.lesson === 'alerts'`,
    );
    await cdp.eval(`document.querySelector('input[aria-label="Notify me before events"]').click()`);
    await expect.poll(async () => (await onboarding(app))?.lessons.alerts).toBe('done');
    await cdp.clickTestId('lesson-done');
    await cdp.waitFor(
      `document.querySelector('[data-testid="panel"]')?.dataset.panelKind !== 'lesson'`,
    );

    await cdp.clickTestId('getting-started-row-zones');
    await cdp.waitFor(
      `document.querySelector('[data-testid="lesson-panel"]')?.dataset.lesson === 'zones'`,
    );
    await cdp.waitFor(`!!document.querySelector('[data-testid="time-zones"]')`);
    await cdp.clickTestId('lesson-done');
    await expect.poll(async () => (await onboarding(app))?.lessons.zones).toBe('skipped');
    await cdp.waitFor(
      `document.querySelector('[data-testid="getting-started-progress"]')?.textContent === '4 of 6'`,
    );
  });

  it('folds to one line and back, and Hide removes the card', async () => {
    const { cdp } = app;
    await cdp.clickTestId('getting-started-collapse');
    await cdp.waitFor(
      `document.querySelector('[data-testid="getting-started"]')?.dataset.cardState === 'collapsed'`,
    );
    await expect.poll(async () => (await onboarding(app))?.card).toBe('collapsed');
    await cdp.clickTestId('getting-started');
    await cdp.waitFor(
      `document.querySelector('[data-testid="getting-started"]')?.dataset.cardState === 'expanded'`,
    );
    await cdp.clickTestId('getting-started-more');
    await cdp.clickTestId('getting-started-hide');
    await cdp.waitFor(`!document.querySelector('[data-testid="getting-started"]')`);
    await expect.poll(async () => (await onboarding(app))?.card).toBe('hidden');
  });

  it('lists the lessons in Settings › Getting Started, opens one in the calendar, and starts over', async () => {
    const { cdp } = app;
    const settings = await app.openSettings('gettingstarted');
    await settings.waitFor(
      `document.querySelector('[data-testid="getting-started-count"]')?.textContent === '4 of 6 done'`,
    );
    expect(
      await settings.eval<boolean>(
        `document.querySelector('[data-testid="getting-started-show"]').checked`,
      ),
    ).toBe(false);
    expect(
      await settings.eval<string | undefined>(
        `document.querySelector('[data-testid="getting-started-lesson-alerts"]')?.dataset.mark`,
      ),
    ).toBe('done');

    // Open hops to the calendar window, which shows the lesson in its panel.
    await settings.clickTestId('getting-started-open-contacts');
    await cdp.waitFor(
      `document.querySelector('[data-testid="lesson-panel"]')?.dataset.lesson === 'contacts'`,
    );
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
    await cdp.waitFor(
      `document.querySelector('[data-testid="getting-started-progress"]')?.textContent === '0 of 6'`,
    );
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
    await cdp.waitFor(
      `document.querySelector('[data-testid="setup-dialog"]')?.dataset.step === 'welcome'`,
    );
    await cdp.clickTestId('setup-skip');
    await cdp.waitFor(`!document.querySelector('[data-testid="setup-dialog"]')`);
    await expect.poll(async () => (await onboarding(app))?.setup).toBe('skipped');
    await cdp.waitFor(`!!document.querySelector('[data-testid="getting-started-row-accounts"]')`);

    await cdp.clickTestId('getting-started-row-accounts');
    await cdp.waitFor(
      `document.querySelector('[data-testid="setup-dialog"]')?.dataset.step === 'sources'`,
    );
    expect(await step(cdp)).toBe('sources');
    // Escape leaves it as before: skipped, the card still there.
    await cdp.pressEscape();
    await cdp.waitFor(`!document.querySelector('[data-testid="setup-dialog"]')`);
    expect((await onboarding(app))?.setup).toBe('skipped');
    await cdp.waitFor(`!!document.querySelector('[data-testid="getting-started-row-accounts"]')`);
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
    await app.cdp.waitFor(`!!document.querySelector('[data-testid="getting-started"]')`);
    await sleep(1000);
    expect(await app.cdp.eval(`!!document.querySelector('[data-testid="setup-dialog"]')`)).toBe(
      false,
    );
    expect(
      await app.cdp.eval(
        `!!document.querySelector('[data-testid="getting-started-row-accounts"]')`,
      ),
    ).toBe(false);
  });

  it('CALENDAR_ONBOARDING=off shows neither on an empty profile', async () => {
    await off.cdp.waitFor(`!!document.querySelector('[data-testid="sidebar"]')`);
    await sleep(1500);
    expect(
      await off.cdp.eval(
        `!!document.querySelector('[data-testid="setup-dialog"], [data-testid="getting-started"]')`,
      ),
    ).toBe(false);
    expect(await onboarding(off)).toBeNull();
  });
});
