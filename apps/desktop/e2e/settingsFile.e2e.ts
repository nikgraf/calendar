import { readFileSync, writeFileSync } from 'node:fs';
import { Account, CalendarInfo } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type App,
  launchApp,
  readAccounts,
  readCalendars,
  readDeviceSetting,
  readSettings,
} from './harness.ts';

const account = new Account({
  contactsEnabled: false,
  createdAt: 1,
  email: 'e2e@nikgraf.com',
  id: 'acc-e2e',
  provider: 'google',
  status: 'ok',
  tasksEnabled: false,
});

const calendar = new CalendarInfo({
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

const seed = { accounts: [account], calendars: [calendar], events: [] };

const fileText = (app: App): string => readFileSync(app.settingsFilePath, 'utf8');

const openSettings = async (cdp: App['cdp']) => {
  await cdp.eval(
    `[...document.querySelectorAll('button')].find(b => b.title === 'Accounts')?.click()`,
  );
  await cdp.waitFor(`!!document.querySelector('[data-testid="settings-file"]')`);
};

const statusText = (cdp: App['cdp']) =>
  cdp.eval<string>(
    `document.querySelector('[data-testid="settings-file-status"]')?.textContent ?? ''`,
  );

describe('settings file: applied at launch and while running, written back on edits', () => {
  let app: App;

  beforeAll(async () => {
    app = await launchApp(seed, {
      settingsFile: [
        '// the machine setup file',
        '{',
        '  "version": 1,',
        '  "timeZones": { "primary": "UTC", "zones": ["UTC", "Asia/Kolkata"] },',
        '  "view": { "allDayLaneCollapsed": true },',
        '  "desktop": { "screenPrivacy": "visible" },',
        '  "accounts": [',
        '    { "kind": "google", "email": "file@nikgraf.com", "calendars": [] }',
        '  ]',
        '}',
        '',
      ].join('\n'),
    });
  });

  afterAll(async () => {
    await app?.stop();
  });

  it('applies the file found at launch: settings, privacy and a sign-in checklist', async () => {
    const { cdp } = app;
    await expect
      .poll(() => readDeviceSetting(app.userDataDir, 'timeZones'), { timeout: 15_000 })
      .toEqual({ primary: 'UTC', zones: ['UTC', 'Asia/Kolkata'] });
    expect(await readDeviceSetting(app.userDataDir, 'viewPreferences')).toEqual({
      allDayLaneCollapsed: true,
    });
    await expect
      .poll(() => readSettings(app.userDataDir)['screenPrivacy'], { timeout: 10_000 })
      .toBe('visible');
    // The grid draws the secondary zone under each hour.
    await cdp.waitFor(`!!document.querySelector('[data-testid="hour-secondary-12"]')`);

    const accounts = await readAccounts(app.userDataDir);
    const added = accounts.find((entry) => entry.email === 'file@nikgraf.com');
    expect(added?.status).toBe('reauth_required');
    expect(added?.provider).toBe('google');
    await cdp.waitFor(`document.body.textContent.includes('file@nikgraf.com')`);
    await cdp.waitFor(`document.body.textContent.includes('sign in again')`);

    const applied = (await readDeviceSetting(app.userDataDir, 'settingsFile')) as {
      hash?: string;
    } | null;
    expect(typeof applied?.hash).toBe('string');

    await openSettings(cdp);
    await expect
      .poll(() => statusText(cdp), { timeout: 10_000 })
      .toMatch(/^Watching .*solunivo\.jsonc/);
    // The write-back filled the file in with the seeded account and its calendar.
    await expect.poll(() => fileText(app), { timeout: 10_000 }).toContain('"e2e@nikgraf.com"');
    expect(fileText(app)).toContain('// the machine setup file');
    expect(fileText(app)).toContain('"cal-work"');
  });

  it('applies an edit saved while the app runs', async () => {
    // Edit the way a person would: change two values, add a comment, save.
    const parsed = JSON.parse(fileText(app).replaceAll(/^\s*\/\/.*$/gm, '')) as {
      accounts: Array<{ calendars?: Array<{ id: string; visible: boolean }>; email?: string }>;
      view: { allDayLaneCollapsed: boolean };
    };
    parsed.view.allDayLaneCollapsed = false;
    const work = parsed.accounts
      .find((entry) => entry.email === 'e2e@nikgraf.com')
      ?.calendars?.find((entry) => entry.id === 'cal-work');
    expect(work?.visible).toBe(true);
    work!.visible = false;
    writeFileSync(app.settingsFilePath, `// keep me\n${JSON.stringify(parsed, null, 2)}\n`);
    await expect
      .poll(
        async () =>
          (await readCalendars(app.userDataDir)).find((entry) => entry.id === 'cal-work')
            ?.isVisible,
        { timeout: 15_000 },
      )
      .toBe(false);
    await expect
      .poll(() => readDeviceSetting(app.userDataDir, 'viewPreferences'), { timeout: 10_000 })
      .toEqual({ allDayLaneCollapsed: false });
  });

  it('writes a settings change back, keeping the comments', async () => {
    const { cdp } = app;
    // The Work checkbox in the account card (the settings modal is still open).
    await cdp.waitFor(
      `[...document.querySelectorAll('input[type="checkbox"]')].some(b => b.parentElement?.textContent?.includes('Work') && !b.checked)`,
    );
    await cdp.eval(
      `[...document.querySelectorAll('input[type="checkbox"]')].find(b => b.parentElement?.textContent?.includes('Work') && !b.checked)?.click()`,
    );
    await expect
      .poll(
        async () =>
          (await readCalendars(app.userDataDir)).find((entry) => entry.id === 'cal-work')
            ?.isVisible,
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect
      .poll(() => fileText(app), { timeout: 10_000 })
      .toMatch(/"id": "cal-work",\s*"title": "Work",\s*"visible": true/);
    expect(fileText(app)).toContain('// keep me');
    // Google account entries never carry a token.
    expect(fileText(app)).not.toMatch(/token/i);
  });
});

describe('settings file: created on request', () => {
  let app: App;

  beforeAll(async () => {
    app = await launchApp(seed);
  });

  afterAll(async () => {
    await app?.stop();
  });

  it('starts without a file and creates one from the current state', async () => {
    const { cdp } = app;
    await openSettings(cdp);
    await expect.poll(() => statusText(cdp), { timeout: 10_000 }).toMatch(/^No file yet/);
    expect(() => fileText(app)).toThrow();

    await cdp.eval(`document.querySelector('[data-testid="settings-file-create"]')?.click()`);
    await expect.poll(() => statusText(cdp), { timeout: 10_000 }).toMatch(/^Watching/);
    const created = fileText(app);
    expect(created.startsWith('// Solunivo settings.')).toBe(true);
    const parsed = JSON.parse(created.replaceAll(/^\/\/.*$/gm, '')) as {
      accounts: ReadonlyArray<{ email?: string; kind: string }>;
      version: number;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.accounts).toEqual([
      expect.objectContaining({ email: 'e2e@nikgraf.com', kind: 'google' }),
    ]);

    // A later change lands in the file.
    await cdp.clickButtonWithText('Always visible');
    await expect
      .poll(() => fileText(app), { timeout: 10_000 })
      .toContain('"screenPrivacy": "visible"');
  });
});
