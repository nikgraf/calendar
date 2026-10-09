import { Account, CalendarInfo, GoogleBirthday } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readDeviceSetting } from './harness.ts';

// Birthdays come from two sources: a Google People row seeded into SQLite
// and the same person in a device-contacts fixture (the harness swaps the
// helper for the in-memory fake, so no TCC prompt and no real address
// book). Seeded on today's *local* date so the chip is always in view and
// the detail reads "Today": the app labels the occurrence in the machine's
// zone, and between local midnight and UTC midnight the UTC date is still
// yesterday.
const today = new Date();
const YEARS_AGO = 32;
const person = {
  day: today.getDate(),
  displayName: 'Alice Example',
  month: today.getMonth() + 1,
  year: today.getFullYear() - YEARS_AGO,
};

const seed = {
  accounts: [
    new Account({
      contactsEnabled: true,
      createdAt: 1,
      email: 'e2e@nikgraf.com',
      id: 'acc-e2e',
      provider: 'google',
      status: 'ok',
      tasksEnabled: false,
    }),
  ],
  birthdays: [
    new GoogleBirthday({
      accountId: 'acc-e2e',
      day: person.day,
      displayName: person.displayName,
      month: person.month,
      resourceName: 'people/c1',
      year: person.year,
    }),
  ],
  calendars: [
    new CalendarInfo({
      accessRole: 'owner',
      accountId: 'acc-e2e',
      colorHex: '#4285f4',
      id: 'cal-work',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'Work',
      timeZone: 'UTC',
    }),
  ],
  events: [],
};

describe('contact birthdays', () => {
  let app: App;

  beforeAll(async () => {
    app = await launchApp(seed, {
      contacts: {
        fixture: {
          birthdays: [
            {
              contactId: 'ABC',
              day: person.day,
              displayName: 'alice example',
              month: person.month,
            },
          ],
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await app?.stop();
  });

  it('shows one chip for a person known to Google and the device, with the age', async () => {
    const { cdp } = app;
    await cdp.waitFor(`document.querySelectorAll('[data-birthday]').length > 0`);
    const chips = await cdp.eval<Array<string>>(
      `[...document.querySelectorAll('[data-birthday]')].map(el => el.textContent)`,
    );
    expect(chips).toEqual([`🎂 Alice Example (${YEARS_AGO})`]);
  });

  it('shows the birthday in the month view too', async () => {
    const { cdp } = app;
    await cdp.clickTestId('view-month');
    try {
      await cdp.waitFor(
        `document.querySelectorAll('[data-testid="month-grid"] [data-birthday]').length === 1`,
      );
    } finally {
      // Back to the week lane whatever happened, so the next test's
      // `[data-birthday]` is the lane chip and not a month cell.
      await cdp.clickTestId('view-week');
      await cdp.waitFor(
        `document.querySelectorAll('[data-birthday]').length === 1 && !document.querySelector('[data-testid="month-grid"]')`,
      );
    }
  });

  it('opens a detail that names both sources, and closes with Escape', async () => {
    const { cdp } = app;
    const point = await cdp.locate('[data-birthday]');
    await cdp.click(point.x, point.y);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"][aria-label="Birthday"]')`);
    const sources = await cdp.eval<Array<string>>(
      `[...document.querySelectorAll('[data-testid="birthday-source"]')].map(el => el.textContent)`,
    );
    expect(sources).toEqual(['Google contact · e2e@nikgraf.com', 'Device contact (this Mac)']);
    expect(
      await cdp.eval<boolean>(`document.body.textContent.includes('Today — turns ${YEARS_AGO}')`),
    ).toBe(true);
    // The birthday itself is read-only and its reminders save as they
    // change: no Save button in this dialog.
    expect(
      await cdp.eval<boolean>(
        `[...document.querySelectorAll('[role="dialog"] button')].some(b => b.textContent?.trim() === 'Save')`,
      ),
    ).toBe(false);
    await cdp.pressEscape();
    await cdp.waitFor(`!document.querySelector('[role="dialog"][aria-label="Birthday"]')`);
  });

  it('stores birthday reminder lead times on this device only', async () => {
    const cdp = await app.openSettings('notifications');
    await cdp.waitFor(`document.body.textContent.includes('Birthday reminders')`);
    expect(
      await cdp.eval<boolean>(
        `document.querySelector('[data-testid="birthday-device-only"]')?.textContent?.includes('Stored only on this device') ?? false`,
      ),
    ).toBe(true);
    expect(await readDeviceSetting(app.userDataDir, 'birthdayReminders')).toBeNull();

    // The lead times unlock once reminders are on (desktop has no
    // permission prompt; notifications are off in the harness anyway).
    const clickInput = (label: string) =>
      cdp.eval(`document.querySelector('input[aria-label=${JSON.stringify(label)}]')?.click()`);
    const stored = () => readDeviceSetting(app.userDataDir, 'birthdayReminders');
    await clickInput('Remind me about birthdays');
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ enabled: true, leadDays: [0], time: '09:00' });
    await cdp.waitFor(
      `document.querySelector('input[aria-label="Remind 1 week before"]')?.disabled === false`,
    );
    await clickInput('Remind 1 week before');
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ enabled: true, leadDays: [0, 7], time: '09:00' });
    await cdp.waitFor(
      `document.querySelector('input[aria-label="Remind 1 week before"]')?.checked === true`,
    );
    // Off again: the lead times survive, the switch does not.
    await clickInput('Remind me about birthdays');
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ enabled: false, leadDays: [0, 7], time: '09:00' });
    await app.closeSettings();
  });

  it('gives one person their own lead days from the detail, and resets them', async () => {
    const { cdp } = app;
    const stored = () => readDeviceSetting(app.userDataDir, 'birthdayReminderOverrides');
    const checked = (label: string) =>
      cdp.eval<boolean>(
        `document.querySelector('[data-testid="birthday-reminders"] input[aria-label=${JSON.stringify(label)}]')?.checked ?? false`,
      );
    const openDetail = async () => {
      const point = await cdp.locate('[data-birthday]');
      await cdp.click(point.x, point.y);
      await cdp.waitFor(`!!document.querySelector('[data-testid="birthday-reminders"]')`);
    };
    const clickInDetail = (selector: string) =>
      cdp.eval(
        `document.querySelector(${JSON.stringify(`[data-testid="birthday-reminders"] ${selector}`)})?.click()`,
      );

    await openDetail();
    // The previous test left the general lead days at [0, 7] with the
    // switch off: the boxes show them, and the detail says reminders are off.
    expect(await checked('Remind on the day')).toBe(true);
    expect(await checked('Remind 1 week before')).toBe(true);
    expect(await checked('Remind 2 weeks before')).toBe(false);
    expect(
      await cdp.eval<boolean>(`!!document.querySelector('[data-testid="birthday-reminders-off"]')`),
    ).toBe(true);
    expect(await stored()).toBeNull();

    await clickInDetail('input[aria-label="Remind 2 weeks before"]');
    await expect.poll(stored, { timeout: 10_000 }).toEqual([
      {
        day: person.day,
        displayName: 'Alice Example',
        leadDays: [0, 7, 14],
        month: person.month,
      },
    ]);
    await cdp.pressEscape();
    await cdp.waitFor(`!document.querySelector('[role="dialog"][aria-label="Birthday"]')`);

    // Reopened: read back from SQLite, with the way back to the defaults.
    await openDetail();
    await cdp.waitFor(
      `document.querySelector('[data-testid="birthday-reminders"] input[aria-label="Remind 2 weeks before"]')?.checked === true`,
    );
    await clickInDetail('[data-testid="birthday-reminders-custom"]');
    await expect.poll(stored, { timeout: 10_000 }).toEqual([]);
    await cdp.waitFor(
      `!document.querySelector('[data-testid="birthday-reminders-custom"]') && document.querySelector('[data-testid="birthday-reminders"] input[aria-label="Remind 2 weeks before"]')?.checked === false`,
    );

    // Muted for this person; Settings lists them and resets them too —
    // with the detail still open, which follows the reset instead of
    // holding on to the last value it sent.
    await clickInDetail('input[aria-label="Remind on the day"]');
    await clickInDetail('input[aria-label="Remind 1 week before"]');
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual([
        { day: person.day, displayName: 'Alice Example', leadDays: [], month: person.month },
      ]);

    const settings = await app.openSettings('notifications');
    await settings.waitFor(
      `document.querySelector('[data-testid="birthday-overrides"]')?.textContent?.includes('Alice Example · No reminder') ?? false`,
    );
    await settings.eval(
      `document.querySelector('button[aria-label="Reset reminders for Alice Example"]')?.click()`,
    );
    await expect.poll(stored, { timeout: 10_000 }).toEqual([]);
    await settings.waitFor(`!document.querySelector('[data-testid="birthday-overrides"]')`);
    await app.closeSettings();

    await cdp.waitFor(
      `!document.querySelector('[data-testid="birthday-reminders-custom"]') && document.querySelector('[data-testid="birthday-reminders"] input[aria-label="Remind on the day"]')?.checked === true`,
    );
    expect(await checked('Remind 1 week before')).toBe(true);
    // A toggle now starts from the general lead days, not the muted list.
    await clickInDetail('input[aria-label="Remind 2 weeks before"]');
    await expect.poll(stored, { timeout: 10_000 }).toEqual([
      {
        day: person.day,
        displayName: 'Alice Example',
        leadDays: [0, 7, 14],
        month: person.month,
      },
    ]);
    await clickInDetail('[data-testid="birthday-reminders-custom"]');
    await expect.poll(stored, { timeout: 10_000 }).toEqual([]);
    await cdp.pressEscape();
    await cdp.waitFor(`!document.querySelector('[role="dialog"][aria-label="Birthday"]')`);
  });
});
