import { Account, CalendarInfo, GoogleBirthday } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type App, launchApp, readDeviceSetting } from './harness.ts';

// Birthdays come from two sources: a Google People row seeded into SQLite
// and the same person in a device-contacts fixture (the harness swaps the
// helper for the in-memory fake, so no TCC prompt and no real address
// book). Seeded relative to today so the chip is always in view.
const today = new Date();
const YEARS_AGO = 32;
const person = {
  day: today.getUTCDate(),
  displayName: 'Alice Example',
  month: today.getUTCMonth() + 1,
  year: today.getUTCFullYear() - YEARS_AGO,
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

  it('opens a read-only detail that names both sources, and closes with Escape', async () => {
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
    // Nothing to edit: no Save button in this dialog.
    expect(
      await cdp.eval<boolean>(
        `[...document.querySelectorAll('[role="dialog"] button')].some(b => b.textContent?.trim() === 'Save')`,
      ),
    ).toBe(false);
    await cdp.pressEscape();
    await cdp.waitFor(`!document.querySelector('[role="dialog"][aria-label="Birthday"]')`);
  });

  it('stores birthday reminder lead times on this device only', async () => {
    const { cdp } = app;
    await cdp.eval(
      `[...document.querySelectorAll('button')].find(b => b.title === 'Accounts')?.click()`,
    );
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
    await cdp.pressEscape();
  });
});
