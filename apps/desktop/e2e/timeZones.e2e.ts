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
  email: 'e2e@example.com',
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

// The device entry is the primary, and the launch pins the device zone to
// UTC (TZ): that keeps the seeded noon on today's date on every host. No
// zone here observes DST, so 12:00 UTC is 5:30 PM in Kolkata and 9 PM in
// Tokyo whatever the date.
const seed = {
  accounts: [account],
  calendars: [calendar],
  deviceSettings: {
    timeZones: { primary: 'device', zones: ['device', 'Asia/Kolkata', 'Asia/Tokyo'] },
  },
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

/** Every match's text, in document order. */
const texts = (cdp: App['cdp'], selector: string) =>
  cdp.eval<ReadonlyArray<string>>(
    `[...document.querySelectorAll(${JSON.stringify(selector)})].map((node) => node.textContent)`,
  );

describe('time zones: a stored secondary zone', () => {
  let app: App;

  beforeAll(async () => {
    app = await launchApp(seed, { env: { TZ: 'UTC' } });
  });

  afterAll(async () => {
    await app?.stop();
  });

  it('annotates the hour gutter, the event block, the inspector and the editor in the other zones', async () => {
    const { cdp } = app;
    await cdp.locate('[title^="Noon sync"]');
    // Each other zone has its own line under the hour, in settings order.
    expect(await texts(cdp, '[data-testid="hour-secondary-12"] > *')).toEqual(['5:30 PM', '9 PM']);
    expect(await text(cdp, '[data-testid="hour-secondary-12-Asia-Kolkata"]')).toBe('5:30 PM');
    expect(await text(cdp, '[data-testid="hour-secondary-1-Asia-Tokyo"]')).toBe('10 AM');
    // The cities head the gutter in the same order, the primary first.
    expect(
      await cdp.eval<ReadonlyArray<string>>(
        `[...document.querySelector('[data-testid="zone-cities"]').children].map((node) => node.dataset.testid)`,
      ),
    ).toEqual([
      expect.stringMatching(/^zone-city-/),
      'zone-city-Asia-Kolkata',
      'zone-city-Asia-Tokyo',
    ]);
    expect(await text(cdp, '[data-testid="zone-city-Asia-Kolkata"]')).toBe('Kolkata');
    // The primary line is untouched; the block's third line joins the other zones.
    expect(await text(cdp, '[title^="Noon sync"]')).toContain('12:00 PM – 1:00 PM');
    expect(await text(cdp, '[title^="Noon sync"] [data-testid="event-secondary-times"]')).toBe(
      '5:30 – 6:30 PM Kolkata · 9:00 – 10:00 PM Tokyo',
    );

    // The inspector and the editor stack them, one line per zone.
    const LINES = ['5:30 – 6:30 PM Kolkata', '9:00 – 10:00 PM Tokyo'];
    await cdp.openInspector('[title^="Noon sync"]');
    expect(
      await texts(cdp, '[data-testid="inspector"] [data-testid="event-secondary-times"] > p'),
    ).toEqual(LINES);
    await cdp.clickTestId('inspector-edit');
    const EDITOR = '[data-testid="editor"]';
    await cdp.waitFor(`!!document.querySelector('${EDITOR} input[type="time"]')`);
    expect(await texts(cdp, `${EDITOR} [data-testid="event-secondary-times"] > p`)).toEqual(LINES);
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

  it('adds, promotes and removes zones on this device only; the device zone stays', async () => {
    // The settings window edits; the calendar window's grid follows.
    const { cdp: calendar } = app;
    const cdp = await app.openSettings('general');
    const stored = () => readDeviceSetting(app.userDataDir, 'timeZones');
    const deviceZone = await cdp.eval<string>(`Intl.DateTimeFormat().resolvedOptions().timeZone`);
    const deviceCity = deviceZone.slice(deviceZone.lastIndexOf('/') + 1).replaceAll('_', ' ');
    const DEVICE_ROW = '[data-testid="time-zone-row-device"]';
    const clickButton = (label: string) =>
      cdp.eval(`document.querySelector('button[aria-label=${JSON.stringify(label)}]')?.click()`);

    await cdp.waitFor(`!!document.querySelector('[data-testid="time-zones"]')`);
    expect(
      await cdp.eval<boolean>(
        `document.querySelector('[data-testid="time-zones-device-only"]')?.textContent?.includes('Stored only on this device') ?? false`,
      ),
    ).toBe(true);
    expect(await stored()).toBeNull();
    // Nothing stored: the device's own zone, named by the city it is in, is the primary and has no Remove.
    expect(await text(cdp, `${DEVICE_ROW} .font-medium`)).toBe(deviceCity);
    expect(await cdp.eval(`document.querySelector('${DEVICE_ROW}')?.dataset.primary`)).toBe('true');
    expect(
      await cdp.eval(`!!document.querySelector('${DEVICE_ROW} button[aria-label^="Remove"]')`),
    ).toBe(false);
    // No secondary zone yet: the gutter has a single line.
    expect(
      await calendar.eval(`!!document.querySelector('[data-testid="hour-secondary-12"]')`),
    ).toBe(false);

    // The picker opens on the whole catalog in a list that scrolls; a
    // query no zone matches says so, and Cancel brings the button back.
    const LIST = '[data-testid="time-zone-options-list"]';
    const optionCount = () =>
      cdp.eval<number>(`document.querySelectorAll('${LIST} [role="option"]').length`);
    await clickButton('Add time zone');
    await cdp.waitFor(`!!document.querySelector('${LIST}')`);
    const catalog = await optionCount();
    expect(catalog).toBeGreaterThan(300);
    expect(
      await cdp.eval<boolean>(
        `(() => { const list = document.querySelector('${LIST}'); return list.scrollHeight > list.clientHeight; })()`,
      ),
    ).toBe(true);
    // The arrows scroll the list to keep the highlighted row in view, and
    // only the list: the Settings pane around it stays where it was.
    const ancestorScroll = `(() => { let sum = 0; for (let node = document.querySelector('${LIST}').parentElement; node; node = node.parentElement) sum += node.scrollTop; return sum + (document.scrollingElement?.scrollTop ?? 0); })()`;
    const paneBefore = await cdp.eval<number>(ancestorScroll);
    for (let step = 0; step < 15; step += 1) {
      await cdp.send('Input.dispatchKeyEvent', {
        code: 'ArrowDown',
        key: 'ArrowDown',
        type: 'rawKeyDown',
        windowsVirtualKeyCode: 40,
      });
    }
    await cdp.waitFor(
      `document.querySelector('${LIST} [role="option"][aria-selected="true"]')?.id === 'time-zone-options-15'`,
    );
    expect(
      await cdp.eval<boolean>(
        `(() => { const list = document.querySelector('${LIST}'); const row = document.getElementById('time-zone-options-15'); return list.scrollTop > 0 && row.offsetTop >= list.scrollTop && row.offsetTop + row.offsetHeight <= list.scrollTop + list.clientHeight; })()`,
      ),
    ).toBe(true);
    expect(await cdp.eval<number>(ancestorScroll)).toBe(paneBefore);
    await cdp.type('input[aria-label="Search time zones"]', 'zzzz');
    await cdp.waitFor(`!!document.querySelector('[data-testid="time-zone-no-match"]')`);
    await cdp.clickTestId('time-zone-cancel');
    await cdp.waitFor(`!!document.querySelector('button[aria-label="Add time zone"]')`);

    // Add Kolkata through the search: typing narrows the list.
    await clickButton('Add time zone');
    await cdp.type('input[aria-label="Search time zones"]', 'kolk');
    await cdp.waitFor(
      `document.querySelectorAll('${LIST} [role="option"]').length < ${String(catalog)}`,
    );
    const option = await cdp.locate('[data-testid="time-zone-option-Asia-Kolkata"]');
    await cdp.click(option.x, option.y);
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ primary: 'device', zones: ['device', 'Asia/Kolkata'] });
    await cdp.waitFor(`!!document.querySelector('[data-testid="time-zone-row-Asia-Kolkata"]')`);
    // The grid in the calendar window already lists it under each hour.
    await calendar.waitFor(`!!document.querySelector('[data-testid="hour-secondary-12"]')`);

    // Make it primary.
    await clickButton('Make Kolkata primary');
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ primary: 'Asia/Kolkata', zones: ['device', 'Asia/Kolkata'] });
    await cdp.waitFor(
      `document.querySelector('[data-testid="time-zone-row-Asia-Kolkata"]')?.dataset.primary === 'true'`,
    );
    expect(
      await cdp.eval(`document.querySelector('${DEVICE_ROW}')?.dataset.primary`),
    ).toBeUndefined();
    // The primary's city heads the gutter.
    await calendar.waitFor(
      `document.querySelector('[data-testid="zone-cities"]')?.firstElementChild?.dataset.testid === 'zone-city-Asia-Kolkata'`,
    );

    // Remove the primary: the device zone takes over again, the gutter's
    // other lines and its city header go.
    await clickButton('Remove Kolkata');
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ primary: 'device', zones: ['device'] });
    await cdp.waitFor(`document.querySelector('${DEVICE_ROW}')?.dataset.primary === 'true'`);
    await calendar.waitFor(`!document.querySelector('[data-testid="hour-secondary-12"]')`);
    expect(await calendar.eval(`!!document.querySelector('[data-testid="zone-cities"]')`)).toBe(
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
      .toEqual({ primary: 'device', zones: ['device', 'Pacific/Honolulu', 'UTC'] });
    await cdp.waitFor(
      `document.querySelector('button[aria-label="Add time zone"]')?.disabled === true`,
    );
    await app.closeSettings();
  });
});
