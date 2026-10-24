import { Account, CalendarInfo, type OnboardingState } from '@calendar/core';
import { decodeSettingsCode, encodeSettingsCode } from '@calendar/core/settingsCode';
import { Effect } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readAccounts, readDeviceSetting } from './harness.ts';

const account = new Account({
  contactsEnabled: false,
  createdAt: 1,
  email: 'e2e@example.com',
  id: 'acc-e2e',
  provider: 'google',
  status: 'ok',
  tasksEnabled: false,
});
const work = new CalendarInfo({
  accessRole: 'owner',
  accountId: 'acc-e2e',
  colorHex: '#3b82f6',
  id: 'cal-work',
  isPrimary: true,
  isVisible: true,
  provider: 'google',
  summary: 'Work',
  timeZone: 'UTC',
});
const holidays = new CalendarInfo({
  accessRole: 'reader',
  accountId: 'acc-e2e',
  colorHex: '#16a34a',
  id: 'cal-holidays',
  isPrimary: false,
  isVisible: false,
  provider: 'google',
  summary: 'Holidays',
  timeZone: 'UTC',
});
const seed = { accounts: [account], calendars: [work, holidays], events: [] };

/** What another device's code would carry: an account this Mac has never seen. */
const otherCode = encodeSettingsCode({
  accounts: [
    {
      calendars: [{ id: 'cal-other', title: 'Other', visible: false }],
      email: 'someone@example.com',
      kind: 'google',
    },
  ],
  version: 1,
});

/** A paste as the OS delivers it; synthetic, so it inserts nothing by itself. */
const paste = (text: string, target = 'window') => `(() => {
  const data = new DataTransfer();
  data.setData('text/plain', ${JSON.stringify(text)});
  ${target}.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
})()`;

const textOf = (cdp: App['cdp'], testId: string) =>
  cdp.eval<string>(`document.querySelector('[data-testid="${testId}"]')?.textContent ?? ''`);

const CAPTURE_STATE = `(document.querySelector('[data-capture-state]')?.dataset.captureState ?? '')`;

describe('settings code: shown in Settings › Settings File, read by paste', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { model: 'fixture' });
  });
  afterAll(async () => {
    await app?.stop();
  });

  it('shows this Mac’s settings as a code only once asked, and the code decodes to them', async () => {
    const settings = await app.openSettings('file');
    await settings.waitFor(`!!document.querySelector('[data-testid="settings-code-section"]')`);
    expect(
      await settings.eval(`!!document.querySelector('[data-testid="settings-code-qr"]')`),
    ).toBe(false);
    await settings.clickTestId('settings-code-show');
    await settings.waitFor(`!!document.querySelector('[data-testid="settings-code-qr"]')`);
    const code = await textOf(settings, 'settings-code-text');
    expect(code).toMatch(/^SOLUNIVO:1:[A-Z2-7]+$/);
    const document = Effect.runSync(decodeSettingsCode(code));
    const [carried] = document.accounts ?? [];
    expect(carried).toMatchObject({ email: 'e2e@example.com', kind: 'google' });
    // Google titles stay home (the import matches by id); visibility travels.
    expect(carried && 'calendars' in carried ? carried.calendars : []).toEqual([
      { id: 'cal-holidays', title: '', visible: false },
      { id: 'cal-work', title: '', visible: true },
    ]);
    expect(await textOf(settings, 'settings-code')).toContain('1 Google account');
  });

  it('reads a pasted code in Copy from iPhone…, previews it and imports it', async () => {
    const settings = await app.openSettings('file');
    await settings.clickTestId('settings-code-read');
    await settings.waitFor(`!!document.querySelector('[data-testid="code-paste"]')`);
    // CALENDAR_CAMERA=off: once macOS's answer is in, the paste field only.
    await settings.waitFor(
      `document.querySelector('[data-testid="code-camera"]')?.dataset.cameraState === 'unavailable'`,
    );
    expect(
      await settings.eval(`document.querySelector('[data-testid="code-camera"]').hidden`),
    ).toBe(true);
    await settings.eval(paste('HELLO', `document.querySelector('[data-testid="code-paste"]')`));
    await settings.waitFor(
      `document.querySelector('[data-testid="code-notice"]')?.textContent.includes('isn’t a Solunivo code')`,
    );
    await settings.eval(
      paste(`Here it is:\n${otherCode}\n`, `document.querySelector('[data-testid="code-paste"]')`),
    );
    await settings.waitFor(`!!document.querySelector('[data-testid="code-import-preview"]')`);
    expect(await textOf(settings, 'code-import-preview')).toContain('someone@example.com');
    await settings.clickTestId('code-import-preview-confirm');
    await settings.waitFor(`!!document.querySelector('[data-testid="code-import-done"]')`);
    await expect
      .poll(async () =>
        (await readAccounts(app.userDataDir)).map((row) => `${row.email}:${row.status}`),
      )
      .toContain('someone@example.com:reauth_required');
    await settings.clickButtonWithText('Done');
    await settings.waitFor(`!document.querySelector('[data-testid="code-import-done"]')`);
  });

  it('opens the import preview for a code pasted on the calendar or in ⌘K, never a capture', async () => {
    const { cdp } = app;
    await cdp.eval(paste(otherCode));
    await cdp.waitFor(`!!document.querySelector('[data-testid="code-import-preview"]')`);
    expect(await cdp.eval<string>(CAPTURE_STATE)).toBe('');
    // The account is already here: the preview says what still differs.
    expect(await textOf(cdp, 'code-import-preview')).not.toContain('Adds someone@example.com');
    await cdp.clickTestId('code-import-preview-cancel');
    await cdp.waitFor(`!document.querySelector('[data-testid="code-import-preview"]')`);

    const commandK = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))`;
    const INPUT = `document.querySelector('[data-testid="quick-add-input"]')`;
    await cdp.eval(commandK);
    await cdp.waitFor(`document.activeElement === ${INPUT}`);
    await cdp.eval(paste(otherCode, INPUT));
    await cdp.waitFor(`!!document.querySelector('[data-testid="code-import-preview"]')`);
    expect(await cdp.eval<string>(`${INPUT}?.value ?? ''`)).toBe('');
    await cdp.clickTestId('code-import-preview-cancel');
    await cdp.waitFor(`!document.querySelector('[data-testid="code-import-preview"]')`);
    await cdp.pressEscape();
  });
});

describe('settings code: the setup dialog’s copy door reads the iPhone’s code by camera', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(undefined, { camera: { code: otherCode }, onboarding: 'on' });
  });
  afterAll(async () => {
    await app?.stop();
  });

  const step = () =>
    app.cdp.eval<string | null>(
      `document.querySelector('[data-testid="setup-dialog"]')?.dataset.step ?? null`,
    );

  it('reads the code, previews it, and lists the sign-in that is left', async () => {
    const { cdp } = app;
    await cdp.waitFor(
      `document.querySelector('[data-testid="setup-dialog"]')?.dataset.step === 'welcome'`,
    );
    await cdp.clickTestId('setup-copy');
    await expect.poll(step).toBe('copy');
    const preview = `!!document.querySelector('[data-testid="setup-import-preview"]')`;
    // The fixture camera sees the code in its first frame.
    await cdp.waitFor(preview);
    expect(await textOf(cdp, 'setup-import-preview')).toContain('someone@example.com');
    // Turned down: the camera, still seeing it every frame, leaves it be…
    await cdp.clickTestId('setup-import-cancel');
    await cdp.waitFor(`!${preview}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await cdp.eval(preview)).toBe(false);
    expect(await step()).toBe('copy');
    // …while pasting it is asking again.
    await cdp.eval(paste(otherCode, `document.querySelector('[data-testid="code-paste"]')`));
    await cdp.waitFor(preview);
    await cdp.clickTestId('setup-import-confirm');
    await expect.poll(step).toBe('copied');
    const someone = (await readAccounts(app.userDataDir)).find(
      (row) => row.email === 'someone@example.com',
    );
    expect(someone?.status).toBe('reauth_required');
    await cdp.waitFor(
      `!!document.querySelector('[data-testid="setup-copied-sign-in-${someone?.id}"]')`,
    );
    await cdp.clickTestId('setup-finish');
    await cdp.waitFor(`!document.querySelector('[data-testid="setup-dialog"]')`);
  });

  it('shows this Mac’s code in the Set up your iPhone lesson, and the reveal ticks it', async () => {
    const { cdp } = app;
    await cdp.clickTestId('getting-started-row-otherDevice');
    await cdp.waitFor(
      `document.querySelector('[data-testid="lesson-panel"]')?.dataset.lesson === 'otherDevice'`,
    );
    expect(await cdp.eval(`!!document.querySelector('[data-testid="settings-code-qr"]')`)).toBe(
      false,
    );
    await cdp.clickTestId('settings-code-show');
    await cdp.waitFor(`!!document.querySelector('[data-testid="settings-code-qr"]')`);
    await expect
      .poll(
        async () =>
          ((await readDeviceSetting(app.userDataDir, 'onboarding')) as OnboardingState | null)
            ?.lessons.otherDevice,
      )
      .toBe('done');
    await cdp.clickTestId('lesson-done');
  });
});
