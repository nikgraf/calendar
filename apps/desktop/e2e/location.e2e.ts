import { Account, CalendarInfo, EventRecord, GeoLocation } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  type App,
  launchApp,
  localDayAt,
  readLocationGeoCount,
  readPendingOps,
} from './harness.ts';

// Places come from the in-memory geo fixture (CALENDAR_GEO=fixture): the
// typeahead, geocoding and the map image are deterministic and offline,
// and MapKit is never asked. Covers picking a suggestion, the map + Open
// in Maps link, that saving queues the coordinates with the update, that
// stored coordinates render without a lookup, and that meeting links get
// neither suggestions nor a map.
const HOUR_MS = 60 * 60 * 1000;
/** Today at the given local hour. */
const todayAt = (hour: number): number => localDayAt(0, hour);

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
    event({ hour: 11, id: 'evt-lunch', title: 'Lunch plan' }),
    event({ geo: STORED, hour: 14, id: 'evt-mass', location: STORED.source, title: 'Mass' }),
    event({
      hour: 16,
      id: 'evt-studio',
      location: 'Unlisted studio, 42 Example Lane',
      title: 'Studio visit',
    }),
    event({
      hour: 18,
      id: 'evt-call',
      location: 'https://meet.google.com/abc-defg-hij',
      title: 'Video call',
    }),
    // Last week's, with coordinates: where the user's places are, whatever
    // zone the machine is in. Vienna is nearby, San Francisco is not.
    event({
      endUtc: localDayAt(-7, 15),
      geo: STORED,
      hour: 14,
      id: 'evt-mass-past',
      location: STORED.source,
      startUtc: localDayAt(-7, 14),
      title: 'Mass last week',
    }),
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
      // What MapKit answers for a typed "kaffeemik": its completer a
      // namesake in Berlin, its search the café in Vienna.
      {
        lat: 52.5057,
        lng: 13.6145,
        name: 'kaffeemike',
        subtitle: 'Erich-Baron-Weg 83, 12623 Berlin',
        title: 'kaffeemike',
      },
      {
        lat: 48.2003,
        lng: 16.3497,
        misspellings: ['kaffeemik'],
        name: 'Kaffemik',
        subtitle: 'Zollergasse 5, 1070 Wien',
        title: 'Kaffemik',
      },
    ],
  },
};

const INPUT = 'input[aria-label="Location"]';

describe('location picker and map', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { geo });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  const typeLocation = async (text: string) => {
    await app.cdp.evaluate(
      ($, input: string, value: string) => {
        $.el(input)!.focus();
        $.setValue(input, value);
      },
      INPUT,
      text,
    );
  };
  const pressKey = (key: string) =>
    app.cdp.evaluate(
      ($, input: string, pressed: string) =>
        $.el(input)!.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: pressed }),
        ),
      INPUT,
      key,
    );
  const openEvent = async (title: string) => {
    await app.cdp.openEditor(`[title^="${title}"]`);
    await app.cdp.waitUntil(($, input: string) => $.has(input), INPUT);
  };

  it('picks a suggestion, maps it, and queues the coordinates with the update', async () => {
    const { cdp } = app;
    await openEvent('Coffee chat');
    expect(await cdp.evaluate(($) => $.has('[data-map]'))).toBe(false);

    await typeLocation('blue');
    await cdp.waitUntil(($) => $.count('[role="option"]') === 1);
    expect(await cdp.evaluate(($) => $.el('[role="option"]')!.textContent)).toContain('66 Mint St');
    await pressKey('Enter');
    await cdp.waitUntil(
      ($, input: string, label: string) => $.value(input) === label,
      INPUT,
      PICKED_LABEL,
    );
    await cdp.waitUntil(($) => $.count('[role="option"]') === 0);

    await cdp.waitUntil(
      ($) =>
        $.el('img[data-map]')?.getAttribute('src')?.startsWith('data:image/png;base64,') === true,
    );
    expect(await cdp.evaluate(($) => $.el('[data-open-in-maps]')!.getAttribute('href'))).toBe(
      'https://maps.apple.com/?ll=37.7823,-122.4076&q=Blue%20Bottle%20Coffee',
    );

    await cdp.clickButtonWithText('Save');
    await cdp.waitUntil(($, input: string) => !$.has(input), INPUT);
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

  it('offers the nearby place a misspelled name means first, and a pick is that place', async () => {
    const { cdp } = app;
    await openEvent('Lunch plan');
    // One letter too many: the completer knows only the namesake in Berlin.
    await typeLocation('kaffeemik');
    await cdp.waitUntil(($) => $.count('[role="option"]') === 2);
    expect(
      await cdp.evaluate(($) => $.all('[role="option"]').map((option) => option.textContent)),
    ).toEqual([expect.stringContaining('Zollergasse 5'), expect.stringContaining('Berlin')]);
    await pressKey('Enter');
    await cdp.waitUntil(
      ($, input: string) => $.value(input) === 'Kaffemik, Zollergasse 5, 1070 Wien',
      INPUT,
    );
    // The row came with its coordinates: the map is that place.
    await cdp.waitUntil(($) => $.has('img[data-map]'));
    expect(await cdp.evaluate(($) => $.el('[data-open-in-maps]')!.getAttribute('href'))).toBe(
      'https://maps.apple.com/?ll=48.2003,16.3497&q=Kaffemik',
    );
    // The place picked is an edit: Cancel asks first.
    await cdp.clickButtonWithText('Cancel');
    await cdp.answerDiscard(true);
    await cdp.waitUntil(($, input: string) => !$.has(input), INPUT);
  });

  it('maps stored coordinates on open and hides the map for a meeting link', async () => {
    const { cdp } = app;
    // The fixture cannot resolve this text: the map proves the stored
    // coordinates were used without a lookup.
    await openEvent('Mass');
    await cdp.waitUntil(($) => $.has('img[data-map]'));
    expect(await cdp.evaluate(($) => $.el('[data-open-in-maps]')!.getAttribute('href'))).toContain(
      'll=48.2084,16.3735',
    );

    await typeLocation('https://meet.google.com/abc-defg-hij');
    await cdp.waitUntil(($) => !$.has('[data-open-in-maps]'));
    expect(await cdp.evaluate(($) => $.count('[role="option"]'))).toBe(0);
    expect(await cdp.evaluate(($) => $.has('[data-map]'))).toBe(false);

    // Back to the stored text: its coordinates count again.
    await typeLocation(STORED.source);
    await cdp.waitUntil(($) => $.has('img[data-map]'));
    await cdp.clickButtonWithText('Cancel');
    await cdp.waitUntil(($, input: string) => !$.has(input), INPUT);
  });

  it('opens either provider with the place shown in the inspector', async () => {
    const { cdp } = app;
    await cdp.openInspector('[title^="Mass"]');
    await cdp.waitUntil(($) => $.has('[data-testid="apple-maps-directions"]'));
    expect(await cdp.evaluate(($) => $.text('[data-testid="google-maps-directions"]'))).toBe(
      'Google Maps',
    );
    const opened = await cdp.evaluate(($) => {
      const urls: Array<string> = [];
      const original = window.open;
      window.open = (url) => {
        urls.push(String(url));
        return null;
      };
      try {
        $.el('[data-testid="apple-maps-directions"]')!.click();
        $.el('[data-testid="google-maps-directions"]')!.click();
        return urls;
      } finally {
        window.open = original;
      }
    });
    expect(opened).toEqual([
      'https://maps.apple.com/directions?destination=48.2084%2C16.3735',
      'https://www.google.com/maps/dir/?api=1&destination=48.2084%2C16.3735',
    ]);
    await cdp.clickTestId('inspector-close');
  });

  it('keeps directions after a failed lookup, but hides them without a physical place', async () => {
    const { cdp } = app;
    await cdp.openInspector('[title^="Studio visit"]');
    await cdp.waitUntil(($) => $.has('[data-testid="google-maps-directions"]'));
    await cdp.waitUntil(($) => !$.has('[data-map-state="loading"]'));
    expect(await cdp.evaluate(($) => $.has('[data-testid="apple-maps-directions"]'))).toBe(true);
    expect(await cdp.evaluate(($) => $.has('[data-map]'))).toBe(false);
    await cdp.clickTestId('inspector-close');

    for (const title of ['Video call', 'Lunch plan']) {
      await cdp.openInspector(`[title^="${title}"]`);
      expect(await cdp.evaluate(($) => $.has('[data-testid="apple-maps-directions"]'))).toBe(false);
      expect(await cdp.evaluate(($) => $.has('[data-testid="google-maps-directions"]'))).toBe(
        false,
      );
      await cdp.clickTestId('inspector-close');
    }
  });

  it('clears the lookup cache from Settings', async () => {
    // The pick above cached its place.
    expect(await readLocationGeoCount(app.userDataDir)).toBeGreaterThan(0);
    const cdp = await app.openSettings('advanced');
    await cdp.waitUntil(() => document.body.textContent.includes('Clear location cache'));
    await cdp.clickButtonWithText('Clear location cache');
    await cdp.waitUntil(($) => $.has('[data-location-cache="cleared"]'));
    expect(await readLocationGeoCount(app.userDataDir)).toBe(0);
  });
});
