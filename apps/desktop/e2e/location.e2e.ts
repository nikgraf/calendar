import { Account, CalendarInfo, EventRecord, GeoLocation } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type App, launchApp, readLocationGeoCount, readPendingOps } from './harness.ts';

// Places come from the in-memory geo fixture (CALENDAR_GEO=fixture): the
// typeahead, geocoding and the map image are deterministic and offline,
// and MapKit is never asked. Covers picking a suggestion, the map + Open
// in Maps link, that saving queues the coordinates with the update, that
// stored coordinates render without a lookup, and that meeting links get
// neither suggestions nor a map.
const HOUR_MS = 60 * 60 * 1000;
const todayAt = (hour: number): number => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour);
};

const PICKED_LABEL = 'Blue Bottle Coffee, 66 Mint St, San Francisco';
const STORED = new GeoLocation({
  lat: 48.2084,
  lng: 16.3735,
  name: "St. Stephen's Cathedral",
  source: 'Stephansplatz 3, 1010 Wien',
});

const event = (fields: { hour: number; id: string; title: string } & Partial<EventRecord>) =>
  new EventRecord({
    accountId: 'acc-e2e',
    calendarId: 'cal-work',
    endUtc: todayAt(fields.hour) + HOUR_MS,
    etag: `"${fields.id}"`,
    isAllDay: false,
    startTimeZone: 'UTC',
    startUtc: todayAt(fields.hour),
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    updatedAt: 1,
    ...fields,
  });

const seed = {
  accounts: [
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      email: 'e2e@nikgraf.com',
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
      colorHex: '#4285f4',
      id: 'cal-work',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'Work',
      timeZone: 'UTC',
    }),
  ],
  events: [
    event({ hour: 9, id: 'evt-coffee', title: 'Coffee chat' }),
    event({ geo: STORED, hour: 14, id: 'evt-mass', location: STORED.source, title: 'Mass' }),
  ],
};

const geo = {
  fixture: {
    places: [
      {
        lat: 37.7823,
        lng: -122.4076,
        name: 'Blue Bottle Coffee',
        subtitle: '66 Mint St, San Francisco',
        title: 'Blue Bottle Coffee',
      },
    ],
  },
};

const INPUT = `document.querySelector('input[aria-label="Location"]')`;

describe('location picker and map', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { geo });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  const typeLocation = async (text: string) => {
    await app.cdp.eval(`(() => {
      const input = ${INPUT};
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  };
  const pressKey = (key: string) =>
    app.cdp.eval(
      `${INPUT}.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`,
    );
  const openEvent = async (title: string) => {
    const block = await app.cdp.locate(`[title^="${title}"]`);
    await app.cdp.click(block.x, block.y);
    await app.cdp.waitFor(`!!${INPUT}`);
  };

  it('picks a suggestion, maps it, and queues the coordinates with the update', async () => {
    const { cdp } = app;
    await openEvent('Coffee chat');
    expect(await cdp.eval(`!!document.querySelector('[data-map]')`)).toBe(false);

    await typeLocation('blue');
    await cdp.waitFor(`document.querySelectorAll('[role="option"]').length === 1`);
    expect(
      await cdp.eval<string>(`document.querySelector('[role="option"]').textContent`),
    ).toContain('66 Mint St');
    await pressKey('Enter');
    await cdp.waitFor(`${INPUT}.value === ${JSON.stringify(PICKED_LABEL)}`);
    await cdp.waitFor(`document.querySelectorAll('[role="option"]').length === 0`);

    await cdp.waitFor(
      `document.querySelector('img[data-map]')?.getAttribute('src')?.startsWith('data:image/png;base64,') === true`,
    );
    expect(
      await cdp.eval<string>(`document.querySelector('[data-open-in-maps]').getAttribute('href')`),
    ).toBe('https://maps.apple.com/?ll=37.7823,-122.4076&q=Blue%20Bottle%20Coffee');

    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!${INPUT}`);
    await expect
      .poll(async () => {
        const ops = await readPendingOps(app.userDataDir);
        return ops.find((op) => op.kind === 'update' && op.eventId === 'evt-coffee')?.payload;
      })
      .toMatchObject({
        geo: { lat: 37.7823, lng: -122.4076, name: 'Blue Bottle Coffee', source: PICKED_LABEL },
        location: PICKED_LABEL,
      });
  });

  it('maps stored coordinates on open and hides the map for a meeting link', async () => {
    const { cdp } = app;
    // The fixture cannot resolve this text: the map proves the stored
    // coordinates were used without a lookup.
    await openEvent('Mass');
    await cdp.waitFor(`!!document.querySelector('img[data-map]')`);
    expect(
      await cdp.eval<string>(`document.querySelector('[data-open-in-maps]').getAttribute('href')`),
    ).toContain('ll=48.2084,16.3735');

    await typeLocation('https://meet.google.com/abc-defg-hij');
    await cdp.waitFor(`!document.querySelector('[data-open-in-maps]')`);
    expect(await cdp.eval(`document.querySelectorAll('[role="option"]').length`)).toBe(0);
    expect(await cdp.eval(`!!document.querySelector('[data-map]')`)).toBe(false);

    // Back to the stored text: its coordinates count again.
    await typeLocation(STORED.source);
    await cdp.waitFor(`!!document.querySelector('img[data-map]')`);
    await cdp.clickButtonWithText('Cancel');
    await cdp.waitFor(`!${INPUT}`);
  });

  it('clears the lookup cache from Settings', async () => {
    const { cdp } = app;
    // The pick above cached its place.
    expect(await readLocationGeoCount(app.userDataDir)).toBeGreaterThan(0);
    await cdp.clickButtonWithText('Manage accounts…');
    await cdp.waitFor(`document.body.textContent.includes('Clear location cache')`);
    await cdp.clickButtonWithText('Clear location cache');
    await cdp.waitFor(`!!document.querySelector('[data-location-cache="cleared"]')`);
    expect(await readLocationGeoCount(app.userDataDir)).toBe(0);
  });
});
