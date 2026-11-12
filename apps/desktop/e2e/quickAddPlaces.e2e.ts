import { Account, CalendarInfo, EventRecord, GeoLocation } from '@calendar/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readEvents } from './harness.ts';

// The place a phrase names: the fixture model takes the location part of
// its grammar as written, and the thread looks it up — the user's own
// past places first (a seeded event with coordinates), then the geo
// fixture's places in MapKit's stead. The best one that resembles the
// text is taken at once, text and pin, and the rest wait as chips under
// the field, the taken one pressed; a text nobody knows stays as said.
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

// Two Figlmüllers for the search, streets apart (nearer than 100 m they
// would be one place): neither outranks the other.
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
      // The second one is what a search answers when the words say its street.
      {
        lat: 48.212,
        lng: 16.379,
        misspellings: ['Figlmüller, Bäckerstraße'],
        name: 'Figlmüller',
        subtitle: 'Bäckerstraße 6, 1010 Wien',
        title: 'Figlmüller Bäckerstrasse',
      },
      // A namesake on another continent: what a search answers for a
      // dictated name it does not know nearby ("Cafe Meek" for Kaffemik).
      {
        lat: -26.1885,
        lng: 28.3208,
        misspellings: ['Cafe Meek'],
        name: 'Meek Café',
        subtitle: '9 10th Avenue, Benoni, South Africa',
        title: 'Meek Café',
      },
    ],
  },
};

const title = `(document.querySelector('input[placeholder="Title"]')?.value ?? '')`;
const COMMAND_N = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }))`;
const location = `(document.querySelector('input[aria-label="Location"]')?.value ?? '')`;
const choices = `!!document.querySelector('[data-testid="draft-place-choices"]')`;
const pressed = `(document.querySelector('[data-testid="draft-place-choices"] [aria-pressed="true"]')?.dataset.testid ?? '')`;
const picks = `document.querySelectorAll('[data-testid^="draft-place-pick-"]').length`;
// The place on the Assistant's newest card.
const cardPlace = `(document.querySelector('[data-testid="assistant-card-location"]')?.textContent ?? '')`;

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
  const phrase = (text: string) => app.cdp.say(text);

  it('takes a past place said by sound, text and pin, and saves the coordinates', async () => {
    const { cdp } = app;
    await openNew();
    await phrase('Coffee | +0 | 10:00-11:00 | Cafe Zentral');
    await cdp.waitFor(`${location} === 'Café Central'`);
    // The lone place taken is a chip too, pressed, with the text as said beside it.
    await cdp.waitFor(choices);
    expect(await cdp.eval<string>(pressed)).toBe('draft-place-pick-0');
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!document.querySelector('[data-testid="editor"]')`);
    await expect
      .poll(async () =>
        (await readEvents(app.userDataDir)).find((event) => event.title === 'Coffee'),
      )
      .toMatchObject({ geo: { lat: CENTRAL.lat, lng: CENTRAL.lng, source: 'Café Central' } });
  });

  it('leaves a namesake far from the user’s places on offer, the text as said', async () => {
    const { cdp } = app;
    await openNew();
    // The past coffee says where the user's places are: Vienna, not Benoni.
    await phrase('Lunch | +0 | 12:00-13:00 | Cafe Meek');
    await cdp.waitFor(choices);
    expect(await cdp.eval<string>(location)).toBe('Cafe Meek');
    expect(await cdp.eval<string>(pressed)).toBe('draft-place-keep');
    // Still one click away, for the trip the words did not name.
    await cdp.clickTestId('draft-place-pick-0');
    await cdp.waitFor(`${location} === 'Meek Café, 9 10th Avenue, Benoni, South Africa'`);
  });

  it('takes the first of two search hits, offers the other, gives the text back, and hides the row', async () => {
    const { cdp } = app;
    await openNew();
    await phrase('Lunch | +0 | 12:00-13:00 | Figlmüller');
    // The first is taken at once; both are chips, the taken one pressed.
    await cdp.waitFor(`${location} === 'Figlmüller, Wollzeile 5, 1010 Wien'`);
    await cdp.waitFor(choices);
    expect(await cdp.eval<number>(picks)).toBe(2);
    expect(await cdp.eval<string>(pressed)).toBe('draft-place-pick-0');
    expect(await cdp.eval<string>(cardPlace)).toBe('Figlmüller, Wollzeile 5, 1010 Wien');
    await cdp.clickTestId('draft-place-pick-1');
    await cdp.waitFor(`${location} === 'Figlmüller, Bäckerstraße 6, 1010 Wien'`);
    expect(await cdp.eval<string>(pressed)).toBe('draft-place-pick-1');
    // The pick is a step: the card marks the place, the one before struck through after it.
    await cdp.waitFor(
      `${cardPlace} === 'Figlmüller, Bäckerstraße 6, 1010 WienFiglmüller, Wollzeile 5, 1010 Wien'`,
    );
    // The text back as said: no place, the row stays.
    await cdp.clickTestId('draft-place-keep');
    await cdp.waitFor(`${location} === 'Figlmüller'`);
    expect(await cdp.eval<string>(pressed)).toBe('draft-place-keep');
    expect(await cdp.eval<boolean>(choices)).toBe(true);
    await cdp.clickTestId('draft-place-dismiss');
    await cdp.waitFor(`!${choices}`);

    // A later turn: a place nobody knows stays as said, nothing to pick.
    await phrase('| | | Room 9');
    await cdp.waitFor(`${location} === 'Room 9'`);
    expect(await cdp.eval<boolean>(choices)).toBe(false);

    // Edited by hand to something else, the row goes by itself.
    await phrase('| | | Figlmüller');
    await cdp.waitFor(choices);
    await cdp.eval(`(() => {
      const input = document.querySelector('input[aria-label="Location"]');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'Figlmüller Lugeck');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.waitFor(`!${choices}`);
  });

  it('adds where a later turn says the place is to the place as said, and the company to the title', async () => {
    const { cdp } = app;
    await openNew();
    await phrase('Lunch | +0 | 12:00-13:00 | Figlmüller');
    await cdp.waitFor(`${location} === 'Figlmüller, Wollzeile 5, 1010 Wien'`);
    // Said of the place as the words named it, not of the address taken
    // for it — and read without the model: the fixture's grammar has no
    // such sentence.
    await phrase('the one in Bäckerstraße');
    await cdp.waitFor(`${location} === 'Figlmüller, Bäckerstraße 6, 1010 Wien'`);
    expect(await cdp.eval<string>(pressed)).toBe('draft-place-pick-0');
    // Who it is with joins the title; the place stays where it is.
    await phrase('with Stefan');
    await cdp.waitFor(`${title} === 'Lunch with Stefan'`);
    expect(await cdp.eval<string>(location)).toBe('Figlmüller, Bäckerstraße 6, 1010 Wien');
  });
});
