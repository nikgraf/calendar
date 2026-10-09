import { Account, CalendarInfo, EventRecord } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readDeviceSetting } from './harness.ts';

/** Today at the given UTC hour. */
const todayAt = (hour: number): number => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour);
};

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

// A UTC primary keeps the seeded noon on today's date on every host, and
// neither UTC nor Kolkata observes DST, so 12:00 UTC is 5:30 PM in Kolkata
// whatever the date.
const seed = {
  accounts: [account],
  calendars: [calendar],
  deviceSettings: { timeZones: { primary: 'UTC', zones: ['UTC', 'Asia/Kolkata'] } },
  events: [
    new EventRecord({
      accountId: 'acc-e2e',
      calendarId: 'cal-work',
      endUtc: todayAt(13),
      etag: '"e2e"',
      id: 'evt-noon',
      isAllDay: false,
      startTimeZone: 'UTC',
      startUtc: todayAt(12),
      status: 'confirmed',
      syncedAt: 1,
      syncStatus: 'synced',
      title: 'Noon sync',
      updatedAt: 1,
    }),
  ],
};

const text = (cdp: App['cdp'], selector: string) =>
  cdp.eval<string | null>(
    `document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`,
  );

describe('time zones: a stored secondary zone', () => {
  let app: App;

  beforeAll(async () => {
    app = await launchApp(seed);
  });

  afterAll(async () => {
    await app?.stop();
  });

  it('annotates the hour gutter, the event block and the editor in the other zone', async () => {
    const { cdp } = app;
    await cdp.locate('[title^="Noon sync"]');
    expect(await text(cdp, '[data-testid="hour-secondary-12"]')).toBe('5:30 PM');
    expect(await text(cdp, '[data-testid="hour-secondary-1"]')).toBe('6:30 AM');
    // The primary line is untouched; the third line carries the other zone.
    expect(await text(cdp, '[title^="Noon sync"]')).toContain('12:00 PM – 1:00 PM');
    expect(await text(cdp, '[title^="Noon sync"] [data-testid="event-secondary-times"]')).toBe(
      '5:30 – 6:30 PM Kolkata',
    );

    await cdp.openEditor('[title^="Noon sync"]');
    const EDITOR = '[data-testid="editor"]';
    await cdp.waitFor(`!!document.querySelector('${EDITOR} input[type="time"]')`);
    expect(await text(cdp, `${EDITOR} [data-testid="event-secondary-times"]`)).toBe(
      '5:30 – 6:30 PM Kolkata',
    );
    await cdp.pressEscape();
    await cdp.waitFor(`!document.querySelector('${EDITOR} input[type="time"]')`);
  });
});

describe('time zones: the settings section', () => {
  let app: App;

  beforeAll(async () => {
    app = await launchApp({ accounts: [account], calendars: [calendar], events: [] });
  });

  afterAll(async () => {
    await app?.stop();
  });

  it('adds, promotes and removes zones on this device only', async () => {
    // The settings window edits; the calendar window's grid follows.
    const { cdp: calendar } = app;
    const cdp = await app.openSettings('general');
    const stored = () => readDeviceSetting(app.userDataDir, 'timeZones');
    const deviceZone = await cdp.eval<string>(`Intl.DateTimeFormat().resolvedOptions().timeZone`);
    const clickButton = (label: string) =>
      cdp.eval(`document.querySelector('button[aria-label=${JSON.stringify(label)}]')?.click()`);

    await cdp.waitFor(`!!document.querySelector('[data-testid="time-zones"]')`);
    expect(
      await cdp.eval<boolean>(
        `document.querySelector('[data-testid="time-zones-device-only"]')?.textContent?.includes('Stored only on this device') ?? false`,
      ),
    ).toBe(true);
    expect(await stored()).toBeNull();
    // No secondary zone yet: the gutter has a single line.
    expect(
      await calendar.eval(`!!document.querySelector('[data-testid="hour-secondary-12"]')`),
    ).toBe(false);

    // Add Kolkata through the search.
    await clickButton('Add time zone');
    await cdp.type('input[aria-label="Search time zones"]', 'kolk');
    const option = await cdp.locate('[data-testid="time-zone-option-Asia-Kolkata"]');
    await cdp.click(option.x, option.y);
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ primary: deviceZone, zones: [deviceZone, 'Asia/Kolkata'] });
    await cdp.waitFor(`!!document.querySelector('[data-testid="time-zone-row-Asia-Kolkata"]')`);
    // The grid in the calendar window already lists it under each hour.
    await calendar.waitFor(`!!document.querySelector('[data-testid="hour-secondary-12"]')`);

    // Make it primary.
    await clickButton('Make Kolkata primary');
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ primary: 'Asia/Kolkata', zones: [deviceZone, 'Asia/Kolkata'] });
    await cdp.waitFor(
      `document.querySelector('[data-testid="time-zone-row-Asia-Kolkata"]')?.dataset.primary === 'true'`,
    );

    // Drop the device zone: Kolkata stays, the gutter's second line goes.
    const deviceCity = deviceZone.slice(deviceZone.lastIndexOf('/') + 1).replaceAll('_', ' ');
    await clickButton(`Remove ${deviceCity}`);
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ primary: 'Asia/Kolkata', zones: ['Asia/Kolkata'] });
    await calendar.waitFor(`!document.querySelector('[data-testid="hour-secondary-12"]')`);
    // The only zone cannot be removed.
    expect(await cdp.eval(`!!document.querySelector('button[aria-label="Remove Kolkata"]')`)).toBe(
      false,
    );

    // Fill up to three: the add button switches off.
    for (const [query, slug] of [
      ['honolulu', 'Pacific-Honolulu'],
      ['utc', 'UTC'],
    ] as const) {
      await clickButton('Add time zone');
      await cdp.type('input[aria-label="Search time zones"]', query);
      const pick = await cdp.locate(`[data-testid="time-zone-option-${slug}"]`);
      await cdp.click(pick.x, pick.y);
      await cdp.waitFor(`!!document.querySelector('[data-testid="time-zone-row-${slug}"]')`);
    }
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ primary: 'Asia/Kolkata', zones: ['Asia/Kolkata', 'Pacific/Honolulu', 'UTC'] });
    await cdp.waitFor(
      `document.querySelector('button[aria-label="Add time zone"]')?.disabled === true`,
    );
    await app.closeSettings();
  });
});
