import { writeFileSync } from 'node:fs';
import { Account, CalendarInfo, EventRecord, GeoLocation } from '@calendar/core';
import { afterAll, beforeAll, describe, it } from 'vite-plus/test';
import { type App, launchApp } from './harness.ts';

// A PR screenshot: the editor panel after a quick-add phrase named a place.
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CENTRAL = new GeoLocation({
  lat: 48.2105,
  lng: 16.3655,
  name: 'Café Central',
  source: 'Café Central',
});
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
  events: [
    new EventRecord({
      accountId: 'acc-e2e',
      calendarId: 'cal-e2e',
      endUtc: Date.now() - 21 * DAY_MS + HOUR_MS,
      etag: '"c"',
      geo: CENTRAL,
      id: 'evt-central',
      isAllDay: false,
      location: CENTRAL.source,
      startTimeZone: 'Europe/Vienna',
      startUtc: Date.now() - 21 * DAY_MS,
      status: 'confirmed',
      syncedAt: 1,
      syncStatus: 'synced',
      title: 'Coffee with Anna',
      updatedAt: 1,
    }),
  ],
};
const geo = {
  fixture: {
    places: [
      {
        lat: 48.209,
        lng: 16.375,
        name: 'Figlmüller',
        subtitle: 'Wollzeile 5, 1010 Wien',
        title: 'Figlmüller',
      },
      {
        lat: 48.212,
        lng: 16.379,
        name: 'Figlmüller',
        subtitle: 'Bäckerstraße 6, 1010 Wien',
        title: 'Figlmüller Bäckerstrasse',
      },
    ],
  },
};
const location = `(document.querySelector('input[aria-label="Location"]')?.value ?? '')`;

describe('shot', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { geo, model: 'fixture', window: { height: 760, width: 1200 } });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  it('captures the editor panel', async () => {
    const { cdp } = app;
    await cdp.eval(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }))`,
    );
    await cdp.waitFor(
      `document.querySelector('[data-testid="editor-title"]')?.textContent === 'New event'`,
    );
    await cdp.type('[data-testid="quick-add-input"]', 'Lunch | +0 | 12:00-13:00 | Figlmüller');
    await cdp.clickTestId('quick-add-apply');
    await cdp.waitFor(
      process.env['SHOT_WAIT'] === 'choices'
        ? `!!document.querySelector('[data-testid="draft-place-choices"]')`
        : `${location} === 'Figlmüller'`,
    );
    await cdp.waitFor(`!document.querySelector('[data-testid="draft-turn-pending"]')`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const rect = await cdp.eval<{ height: number; width: number; x: number; y: number }>(`(() => {
      const r = document.querySelector('[data-testid="editor"]').getBoundingClientRect();
      return { height: Math.min(r.height, window.innerHeight - r.y), width: r.width, x: r.x, y: r.y };
    })()`);
    const shot = (await cdp.send('Page.captureScreenshot', {
      clip: { ...rect, scale: 2 },
      format: 'png',
    })) as { data: string };
    writeFileSync(process.env['SHOT_OUT']!, Buffer.from(shot.data, 'base64'));
  });
});
