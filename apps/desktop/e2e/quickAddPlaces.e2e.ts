import { Account, CalendarInfo, EventRecord, GeoLocation } from '@calendar/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readEvents } from './harness.ts';

// The place a phrase names: the fixture model takes the location part of
// its grammar as written, and the thread looks it up — the user's own
// past places first (a seeded event with coordinates), then the geo
// fixture's places in MapKit's stead. The best one that resembles the
// text is taken at once, text and pin, and the rest wait as chips under
// the field, the taken one pressed; a text nobody knows stays as said.
// A dictated name is looked for as the recogniser's other readings of it
// have it too, when it names nothing nearby itself: what they find is
// offered, never taken unasked.
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
        // The search reads "Figelmuller", one of dictation's readings of a
        // "Figlmüller" it wrote "Figelmiller", as this one (as MapKit does).
        misspellings: ['Figlmüller, Bäckerstraße', 'Figelmuller'],
        name: 'Figlmüller',
        subtitle: 'Bäckerstraße 6, 1010 Wien',
        title: 'Figlmüller Bäckerstrasse',
      },
      // Two Café Sachers a door apart in Vienna and one in Salzburg, 251 km
      // off: one map cannot show all three, so Salzburg is a tag on its edge.
      {
        lat: 48.20393,
        lng: 16.36968,
        name: 'Café Sacher Wien',
        subtitle: 'Philharmoniker Straße 4, 1010 Wien',
        title: 'Café Sacher',
      },
      {
        lat: 48.20341,
        lng: 16.37014,
        name: 'Sacher Eck Wien',
        subtitle: 'Kärntner Straße 38, 1010 Wien',
        title: 'Café Sacher Eck',
      },
      {
        lat: 47.80447,
        lng: 13.04402,
        name: 'Café Sacher Salzburg',
        subtitle: 'Schwarzstraße 5–7, 5020 Salzburg',
        title: 'Café Sacher Salzburg',
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

// One dictated phrase, as the recogniser read it in segments: the name
// ("Figlmüller", said) a segment of its own, with the readings it weighed.
const DICTATED = {
  segments: [
    // Tomorrow: a saved event that has begun would be a past place for the tests after it.
    { text: 'Dinner | +1 | 19:00-20:00 |' },
    { alternatives: [' Figelmiller', ' Feigelmiller', ' Figelmuller'], text: ' Figelmiller' },
  ],
};

const title = `(document.querySelector('input[placeholder="Title"]')?.value ?? '')`;
const COMMAND_N = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }))`;
const location = `(document.querySelector('input[aria-label="Location"]')?.value ?? '')`;
const choices = `!!document.querySelector('[data-testid="draft-place-choices"]')`;
const pressed = `(document.querySelector('[data-testid="draft-place-choices"] [aria-pressed="true"]')?.dataset.testid ?? '')`;
const picks = `document.querySelectorAll('[data-testid^="draft-place-pick-"]').length`;
const pickText = (index: number) =>
  `(document.querySelector('[data-testid="draft-place-pick-${String(index)}"]')?.textContent ?? '')`;
const dictating = `document.querySelector('[data-testid="quick-add-mic"]')?.getAttribute('aria-pressed') === 'true'`;
const count = `(document.querySelector('[data-testid="draft-question-count"]')?.textContent ?? '')`;
const preview = `!!document.querySelector('[data-testid="step-preview"]')`;
// The place on the Assistant's newest card.
const cardPlace = `(document.querySelector('[data-testid="assistant-card-location"]')?.textContent ?? '')`;
// A map's state: '' while there is none, 'loading', then 'ready' (the geo fixture's image).
const mapState = (testId: string) =>
  `(document.querySelector('[data-testid="${testId}"]')?.dataset.mapState ?? '')`;
const pins = `document.querySelectorAll('[data-testid^="draft-place-pin-"]').length`;

describe('Places from a quick-add phrase', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { geo, microphone: { phrases: [DICTATED] }, model: 'fixture' });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });
  afterEach(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await app.cdp.eval<boolean>(`!!document.querySelector('[data-testid="editor"]')`))) {
        return;
      }
      await app.cdp.escapeOrDiscard();
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

  it('offers what another reading of a dictated name finds, taken only when picked', async () => {
    const { cdp } = app;
    await openNew();
    await cdp.clickTestId('quick-add-mic');
    // "Figelmiller" finds nothing; the reading "Figelmuller" finds Figlmüller.
    await cdp.waitFor(choices, 20_000);
    await cdp.clickTestId('quick-add-mic');
    await cdp.waitFor(`!(${dictating})`);
    expect(await cdp.eval<string>(title)).toBe('Dinner');
    expect(await cdp.eval<string>(location)).toBe('Figelmiller');
    expect(await cdp.eval<string>(count)).toBe('Question 1 of 1');
    expect(await cdp.eval<number>(picks)).toBe(1);
    // Its row leads with its pin's number on the map.
    expect(await cdp.eval<string>(pickText(0))).toBe('1FiglmüllerBäckerstraße 6, 1010 Wien');
    expect(await cdp.eval<string>(pressed)).toBe('draft-place-keep');
    await cdp.clickTestId('draft-place-pick-0');
    await cdp.waitFor(`${location} === 'Figlmüller, Bäckerstraße 6, 1010 Wien'`);
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!document.querySelector('[data-testid="editor"]')`);
    // Picked, the place is vouched for: its coordinates are saved with it.
    await expect
      .poll(async () =>
        (await readEvents(app.userDataDir)).find((event) => event.title === 'Dinner'),
      )
      .toMatchObject({ geo: { lat: 48.212, lng: 16.379 } });
  });

  it('asks which of two search hits, the first taken, and settles it by a pick, the text as said or Skip', async () => {
    const { cdp } = app;
    await openNew();
    await phrase('Lunch | +0 | 12:00-13:00 | Figlmüller');
    // The first is taken at once; the question offers both, the taken one pressed.
    await cdp.waitFor(`${location} === 'Figlmüller, Wollzeile 5, 1010 Wien'`);
    await cdp.waitFor(choices);
    expect(await cdp.eval<string>(count)).toBe('Question 1 of 1');
    expect(await cdp.eval<number>(picks)).toBe(2);
    expect(await cdp.eval<string>(pressed)).toBe('draft-place-pick-0');
    expect(await cdp.eval<string>(cardPlace)).toBe('Figlmüller, Wollzeile 5, 1010 Wien');
    // The other one: taken, and the question answered.
    await cdp.clickTestId('draft-place-pick-1');
    await cdp.waitFor(`${location} === 'Figlmüller, Bäckerstraße 6, 1010 Wien'`);
    await cdp.waitFor(`!${choices}`);
    // The pick is a step: the card marks the place, the one before struck through after it.
    await cdp.waitFor(
      `${cardPlace} === 'Figlmüller, Bäckerstraße 6, 1010 WienFiglmüller, Wollzeile 5, 1010 Wien'`,
    );
    // Going back over the pick asks again.
    await cdp.clickTestId('assistant-undo');
    await cdp.waitFor(preview);
    await cdp.clickTestId('step-use');
    await cdp.waitFor(`!${preview}`);
    await cdp.waitFor(choices);
    expect(await cdp.eval<string>(pressed)).toBe('draft-place-pick-0');
    // The text back as said: no place, and the question answered.
    await cdp.clickTestId('draft-place-keep');
    await cdp.waitFor(`${location} === 'Figlmüller'`);
    await cdp.waitFor(`!${choices}`);

    // A later turn: a place nobody knows stays as said, nothing to pick.
    await phrase('| | | Room 9');
    await cdp.waitFor(`${location} === 'Room 9'`);
    expect(await cdp.eval<boolean>(choices)).toBe(false);

    // Asked again, and skipped: the place stays as taken.
    await phrase('| | | Figlmüller');
    await cdp.waitFor(choices);
    await cdp.waitFor(`${location} === 'Figlmüller, Wollzeile 5, 1010 Wien'`);
    await cdp.clickTestId('draft-question-skip');
    await cdp.waitFor(`!${choices}`);
    expect(await cdp.eval<string>(location)).toBe('Figlmüller, Wollzeile 5, 1010 Wien');

    // Edited by hand to something else, the question goes by itself.
    await phrase('| | | Room 9');
    await cdp.waitFor(`${location} === 'Room 9'`);
    await phrase('| | | Figlmüller');
    await cdp.waitFor(choices);
    await cdp.eval(`(() => {
      const input = document.querySelector('input[aria-label="Location"]');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'Figlmüller Lugeck');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.waitFor(`!${choices}`);
  });

  it('shows the places on one map: a pin takes its place, one in another city is a tag on its edge', async () => {
    const { cdp } = app;
    await openNew();
    await phrase('Coffee | +1 | 15:00-16:00 | Café Sacher');
    await cdp.waitFor(choices);
    expect(await cdp.eval<number>(picks)).toBe(3);
    await cdp.waitFor(`${mapState('draft-place-map')} === 'ready'`);
    // While it asks which place, the card leaves its own map out.
    expect(await cdp.eval<string>(mapState('assistant-card-map'))).toBe('');
    // The two in Vienna are pins; Salzburg is a tag on the map's edge, and
    // its row says how far it is first.
    expect(await cdp.eval<number>(pins)).toBe(2);
    expect(
      await cdp.eval<string>(
        `document.querySelector('[data-testid="draft-place-edge-2"]')?.textContent ?? ''`,
      ),
    ).toBe('3251 km');
    expect(await cdp.eval<string>(pickText(2))).toBe(
      '3Café Sacher Salzburg251 km · Schwarzstraße 5–7, 5020 Salzburg',
    );
    // A pin takes its place as its row does; the card then shows it on its map.
    await cdp.clickTestId('draft-place-pin-1');
    await cdp.waitFor(`${location} === 'Sacher Eck Wien, Kärntner Straße 38, 1010 Wien'`);
    await cdp.waitFor(`!${choices}`);
    await cdp.waitFor(`${mapState('assistant-card-map')} === 'ready'`);
    // Asked again, the tag takes the place in Salzburg.
    await cdp.clickTestId('assistant-undo');
    await cdp.waitFor(preview);
    await cdp.clickTestId('step-use');
    await cdp.waitFor(`!${preview}`);
    await cdp.waitFor(choices);
    await cdp.clickTestId('draft-place-edge-2');
    await cdp.waitFor(`${location} === 'Café Sacher Salzburg, Schwarzstraße 5–7, 5020 Salzburg'`);
  });

  it('looks up a place a later turn changes, and keeps it through a turn about the title', async () => {
    const { cdp } = app;
    await openNew();
    await phrase('Lunch | +0 | 12:00-13:00 | Figlmüller');
    await cdp.waitFor(`${location} === 'Figlmüller, Wollzeile 5, 1010 Wien'`);
    // The model answers where the turn says it is ("the one in
    // Bäckerstraße"); the thread looks that up and takes the best match.
    await phrase('| | | Figlmüller, Bäckerstraße');
    await cdp.waitFor(`${location} === 'Figlmüller, Bäckerstraße 6, 1010 Wien'`);
    expect(await cdp.eval<string>(pressed)).toBe('draft-place-pick-0');
    // A turn about the title only: the place stays where it is.
    await phrase('Lunch with Stefan | | |');
    await cdp.waitFor(`${title} === 'Lunch with Stefan'`);
    expect(await cdp.eval<string>(location)).toBe('Figlmüller, Bäckerstraße 6, 1010 Wien');
  });
});
