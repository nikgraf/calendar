import { Account, CalendarInfo, GoogleBirthday } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readDeviceSetting } from './harness.ts';

const at = (leadDays: number, time = '09:00') => ({ leadDays, time });

/** Sets a controlled input the way typing would, so React sees the change. */
const setInput = (selector: string, value: string) => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, ${JSON.stringify(value)});
  element.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

/** Leaves a field, which is when a time field saves (React's onBlur listens for focusout). */
const leave = (selector: string) =>
  `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new FocusEvent('focusout', { bubbles: true }))`;

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
      email: 'e2e@example.com',
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
    expect(sources).toEqual(['Google contact · e2e@example.com', 'Device contact (this Mac)']);
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

  it('stores birthday reminders, each at its own time, on this device only', async () => {
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
    // Just today's fields: the row also keeps the old ones for older apps.
    const stored = async () => {
      const row = (await readDeviceSetting(app.userDataDir, 'birthdayReminders')) as {
        enabled: boolean;
        reminders: unknown;
      } | null;
      return row && { enabled: row.enabled, reminders: row.reminders };
    };
    await clickInput('Remind me about birthdays');
    await expect.poll(stored, { timeout: 10_000 }).toEqual({ enabled: true, reminders: [at(0)] });
    await cdp.waitFor(
      `document.querySelector('input[aria-label="Remind 1 week before"]')?.disabled === false`,
    );
    // Only a checked lead has a time field.
    expect(
      await cdp.eval<boolean>(`!document.querySelector('input[aria-label="Time 1 week before"]')`),
    ).toBe(true);
    await clickInput('Remind 1 week before');
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ enabled: true, reminders: [at(0), at(7)] });
    await cdp.waitFor(
      `document.querySelector('input[aria-label="Time 1 week before"]')?.value === '09:00'`,
    );
    // Each lead keeps its own time, saved once the field is left: a time
    // half typed is not saved (it would re-plan at a passed time).
    await cdp.eval(setInput('input[aria-label="Time 1 week before"]', '18:30'));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await stored()).toEqual({ enabled: true, reminders: [at(0), at(7)] });
    await cdp.eval(leave('input[aria-label="Time 1 week before"]'));
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ enabled: true, reminders: [at(0), at(7, '18:30')] });
    expect(
      await cdp.eval<string>(
        `document.querySelector('input[aria-label="Time on the day"]')?.value ?? ''`,
      ),
    ).toBe('09:00');
    // Off again: the reminders survive, the switch does not.
    await clickInput('Remind me about birthdays');
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ enabled: false, reminders: [at(0), at(7, '18:30')] });
    // A time typed and the window closed at once: the close waits for the save.
    await cdp.eval(setInput('input[aria-label="Time on the day"]', '07:45'));
    await app.closeSettings();
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ enabled: false, reminders: [at(0, '07:45'), at(7, '18:30')] });
    const back = await app.openSettings('notifications');
    await back.waitFor(
      `document.querySelector('input[aria-label="Time on the day"]')?.value === '07:45'`,
    );
    await back.eval(setInput('input[aria-label="Time on the day"]', '09:00'));
    await back.eval(leave('input[aria-label="Time on the day"]'));
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ enabled: false, reminders: [at(0), at(7, '18:30')] });
    await app.closeSettings();
  });

  it('gives one person their own reminders from the detail, and resets them', async () => {
    const { cdp } = app;
    // Just today's fields: the rows also keep the old ones for older apps.
    const stored = async () => {
      const rows = (await readDeviceSetting(
        app.userDataDir,
        'birthdayReminderOverrides',
      )) as Array<{
        day: number;
        displayName: string;
        month: number;
        reminders: unknown;
      }> | null;
      return (
        rows?.map(({ day, displayName, month, reminders }) => ({
          day,
          displayName,
          month,
          reminders,
        })) ?? null
      );
    };
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

    // A time put back to what it was saves nothing, even as the dialog
    // closes: saving would give the person a list of their own.
    await openDetail();
    const weekTime = '[data-testid="birthday-reminders"] input[aria-label="Time 1 week before"]';
    await cdp.eval(setInput(weekTime, '06:00'));
    await cdp.eval(setInput(weekTime, '18:30'));
    await cdp.pressEscape();
    await cdp.waitFor(`!document.querySelector('[role="dialog"][aria-label="Birthday"]')`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await stored()).toBeNull();

    await openDetail();
    // The previous test left the general reminders at on the day 09:00 and
    // a week before 18:30, switched off: the boxes show them, and the
    // detail says reminders are off.
    expect(await checked('Remind on the day')).toBe(true);
    expect(await checked('Remind 1 week before')).toBe(true);
    expect(await checked('Remind 2 weeks before')).toBe(false);
    expect(
      await cdp.eval<string>(
        `document.querySelector('[data-testid="birthday-reminders"] input[aria-label="Time 1 week before"]')?.value ?? ''`,
      ),
    ).toBe('18:30');
    expect(
      await cdp.eval<boolean>(`!!document.querySelector('[data-testid="birthday-reminders-off"]')`),
    ).toBe(true);
    expect(await stored()).toBeNull();

    // Two weeks starts at the time of the nearest lead, a week before.
    await clickInDetail('input[aria-label="Remind 2 weeks before"]');
    await expect.poll(stored, { timeout: 10_000 }).toEqual([
      {
        day: person.day,
        displayName: 'Alice Example',
        month: person.month,
        reminders: [at(0), at(7, '18:30'), at(14, '18:30')],
      },
    ]);
    // A time of this person's own, typed and closed with Escape at once:
    // the field saves as it goes away.
    await cdp.eval(
      setInput(
        '[data-testid="birthday-reminders"] input[aria-label="Time 2 weeks before"]',
        '08:15',
      ),
    );
    await cdp.pressEscape();
    await cdp.waitFor(`!document.querySelector('[role="dialog"][aria-label="Birthday"]')`);
    await expect.poll(stored, { timeout: 10_000 }).toEqual([
      {
        day: person.day,
        displayName: 'Alice Example',
        month: person.month,
        reminders: [at(0), at(7, '18:30'), at(14, '08:15')],
      },
    ]);

    // Reopened: read back from SQLite, with the way back to the defaults.
    await openDetail();
    await cdp.waitFor(
      `document.querySelector('[data-testid="birthday-reminders"] input[aria-label="Time 2 weeks before"]')?.value === '08:15'`,
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
        { day: person.day, displayName: 'Alice Example', month: person.month, reminders: [] },
      ]);

    const settings = await app.openSettings('notifications');
    await settings.waitFor(
      `document.querySelector('[data-testid="birthday-overrides"] li')?.textContent === 'Alice ExampleNo reminderReset'`,
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
    // A toggle now starts from the general reminders, not the muted list.
    await clickInDetail('input[aria-label="Remind 2 weeks before"]');
    await expect.poll(stored, { timeout: 10_000 }).toEqual([
      {
        day: person.day,
        displayName: 'Alice Example',
        month: person.month,
        reminders: [at(0), at(7, '18:30'), at(14, '18:30')],
      },
    ]);
    // A time typed but not saved yet, then the person reset elsewhere:
    // their two-week field goes away with the override and drops the
    // time rather than saving the list it was typed into back.
    const twoWeeks = '[data-testid="birthday-reminders"] input[aria-label="Time 2 weeks before"]';
    await cdp.eval(setInput(twoWeeks, '06:00'));
    const again = await app.openSettings('notifications');
    await again.waitFor(`!!document.querySelector('[data-testid="birthday-overrides"]')`);
    await again.eval(
      `document.querySelector('button[aria-label="Reset reminders for Alice Example"]')?.click()`,
    );
    await expect.poll(stored, { timeout: 10_000 }).toEqual([]);
    await app.closeSettings();
    await cdp.waitFor(`!document.querySelector(${JSON.stringify(twoWeeks)})`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await stored()).toEqual([]);
    expect(
      await cdp.eval<boolean>(
        `!document.querySelector('[data-testid="birthday-reminders-custom"]')`,
      ),
    ).toBe(true);
    await cdp.pressEscape();
    await cdp.waitFor(`!document.querySelector('[role="dialog"][aria-label="Birthday"]')`);
    expect(await stored()).toEqual([]);
  });
});
