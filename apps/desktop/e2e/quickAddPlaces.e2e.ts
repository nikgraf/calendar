import { Account, CalendarInfo, EventRecord, GeoLocation } from '@calendar/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readEvents } from './harness.ts';

// The place a phrase names: the fixture model takes the location part of
// its grammar as written, and the thread looks it up — the user's own
// past places first (a seeded event with coordinates), then the geo
// fixture's places in MapKit's stead. A past place found by sound is
// taken without asking, text and pin; two search hits that rank the
// same are a choice under the field; a text nobody knows stays as said.
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
    // A coffee three weeks back, at a place with coordinates: the history.
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

// Two Figlmüllers for the search: neither outranks the other.
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
        lat: 48.2095,
        lng: 16.376,
        name: 'Figlmüller',
        subtitle: 'Bäckerstraße 6, 1010 Wien',
        title: 'Figlmüller Bäckerstrasse',
      },
    ],
  },
};

const INPUT = '[data-testid="quick-add-input"]';
const COMMAND_N = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }))`;
const location = `(document.querySelector('input[aria-label="Location"]')?.value ?? '')`;
const choices = `!!document.querySelector('[data-testid="draft-place-choices"]')`;
const newestSummary = `document.querySelector('[data-testid="draft-turn-summary"]')?.textContent ?? ''`;

describe('Places from a quick-add phrase', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { geo, model: 'fixture' });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });
  afterEach(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await app.cdp.eval<boolean>(`!!document.querySelector('[data-testid="editor"]')`))) {
        return;
      }
      await app.cdp.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  });

  const openNew = async () => {
    await app.cdp.eval(COMMAND_N);
    await app.cdp.waitFor(
      `document.querySelector('[data-testid="editor-title"]')?.textContent === 'New event'`,
    );
  };
  const phrase = async (text: string) => {
    await app.cdp.type(INPUT, text);
    await app.cdp.clickTestId('quick-add-apply');
  };

  it('takes a past place said by sound, text and pin, and saves the coordinates', async () => {
    const { cdp } = app;
    await openNew();
    await phrase('Coffee | +0 | 10:00-11:00 | Cafe Zentral');
    await cdp.waitFor(`${location} === 'Café Central'`);
    expect(await cdp.eval<boolean>(choices)).toBe(false);
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!document.querySelector('[data-testid="editor"]')`);
    await expect
      .poll(async () =>
        (await readEvents(app.userDataDir)).find((event) => event.title === 'Coffee'),
      )
      .toMatchObject({ geo: { lat: CENTRAL.lat, lng: CENTRAL.lng, source: 'Café Central' } });
  });

  it('asks which of two search hits, takes the pick, and keeps a text nobody knows', async () => {
    const { cdp } = app;
    await openNew();
    await phrase('Lunch | +0 | 12:00-13:00 | Figlmüller');
    await cdp.waitFor(choices);
    expect(await cdp.eval<string>(location)).toBe('Figlmüller');
    expect(await cdp.eval<string>(newestSummary)).toContain('which “Figlmüller”?');
    await cdp.clickTestId('draft-place-pick-0');
    await cdp.waitFor(`${location} === 'Figlmüller, Wollzeile 5, 1010 Wien'`);
    await cdp.waitFor(`!${choices}`);

    // A later turn: a place nobody knows stays as said, nothing to pick.
    await phrase('| | | Room 9');
    await cdp.waitFor(`${location} === 'Room 9'`);
    expect(await cdp.eval<boolean>(choices)).toBe(false);

    // "Keep" leaves the text as said.
    await phrase('| | | Figlmüller');
    await cdp.waitFor(choices);
    await cdp.clickTestId('draft-place-keep');
    await cdp.waitFor(`!${choices}`);
    expect(await cdp.eval<string>(location)).toBe('Figlmüller');
  });
});
