import { Account, CalendarInfo, GoogleContact } from '@calendar/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readEvents } from './harness.ts';
import type { PageKit } from './page.ts';

// People a phrase invites: the fixture model names whoever follows
// "invite" (or "remove"), the code keeps them only under that cue, and
// each name is looked up in the contacts — Google People rows seeded
// straight into SQLite (the harness keeps the device address book off).
// A name that is one contact's becomes a guest chip; one that could be
// several waits for a pick; one nobody has says so and can be let go.
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
  contacts: [
    new GoogleContact({
      accountId: 'acc-e2e',
      displayName: 'Anna Lee',
      email: 'anna@example.com',
      isOther: false,
      resourceName: 'people/c1',
    }),
    new GoogleContact({
      accountId: 'acc-e2e',
      displayName: 'Tom Baker',
      email: 'tom.baker@example.com',
      isOther: false,
      resourceName: 'people/c2',
    }),
    new GoogleContact({
      accountId: 'acc-e2e',
      displayName: 'Tom Lee',
      email: 'tlee@example.com',
      isOther: true,
      resourceName: 'otherContacts/o1',
    }),
  ],
  events: [],
};

// CDP key events don't carry macOS meta reliably: dispatch ⌘N to the app's own window listener.
const commandN = () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }));
};
const chips = ($: PageKit) => $.all('[data-invitee]').map((el) => el.getAttribute('data-invitee'));
// A chip as it reads: the name, the address in parentheses (and its remove button's ×).
const chipText = ($: PageKit, email: string) => $.text(`[data-invitee="${email}"]`);
// The Assistant's newest card: its guests.
const cardGuests = ($: PageKit) => $.text('[data-testid="assistant-card-guests"]');
const choiceText = ($: PageKit, index: number) =>
  $.text(`[data-testid="draft-invitee-choice-${String(index)}"]`);
const hasChoices = ($: PageKit) => $.has('[data-testid="draft-invitee-choices"]');

describe('Invitees from a quick-add phrase', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { model: 'fixture' });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });
  afterEach(async () => {
    // A failure above must not strand an editor for the next test.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await app.cdp.evaluate(($) => $.has('[data-testid="editor"]')))) {
        return;
      }
      await app.cdp.escapeOrDiscard();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  });

  const phrase = (text: string) => app.cdp.say(text);

  it('invites the one contact a name means, asks which for two, takes a guest off, and saves them', async () => {
    const { cdp } = app;
    await cdp.evaluate(commandN);
    await cdp.waitUntil(($) => $.text('[data-testid="editor-title"]') === 'New event');
    await phrase('Lunch | +2 | 13:00-14:00 | | invite Anna Lee and Tom');
    // Anna Lee is one contact: a guest. Tom is two: a question, nothing picked.
    await cdp.waitUntil(($) =>
      $.all('[data-invitee]')
        .map((el) => el.getAttribute('data-invitee'))
        .includes('anna@example.com'),
    );
    expect(await cdp.evaluate(chips)).toEqual(['anna@example.com']);
    expect(await cdp.evaluate(chipText, 'anna@example.com')).toContain(
      'Anna Lee (anna@example.com)',
    );
    await cdp.waitUntil(hasChoices);
    expect(await cdp.evaluate(choiceText, 0)).toContain('Which Tom?');
    expect(await cdp.evaluate(choiceText, 0)).toContain('Tom Baker');
    expect(await cdp.evaluate(choiceText, 0)).toContain('Tom Lee');
    expect(await cdp.evaluate(cardGuests)).toBe('Anna Lee (anna@example.com)');

    // A pick makes that contact a guest; the question goes, and the card marks who joined.
    await cdp.clickTestId('draft-invitee-pick-0-0');
    await cdp.waitUntil(($) =>
      $.all('[data-invitee]')
        .map((el) => el.getAttribute('data-invitee'))
        .includes('tom.baker@example.com'),
    );
    expect(await cdp.evaluate(chipText, 'tom.baker@example.com')).toContain(
      'Tom Baker (tom.baker@example.com)',
    );
    await cdp.waitUntil(($) => !$.has('[data-testid="draft-invitee-choices"]'));
    await cdp.waitUntil(($) => $.text('[data-testid="assistant-changed"]') === 'Changed: guests');
    expect(await cdp.evaluate(cardGuests)).toBe(
      'Anna Lee (anna@example.com), Tom Baker (tom.baker@example.com)',
    );

    // A later phrase takes a guest off by name.
    await phrase('remove Anna');
    await cdp.waitUntil(
      ($) =>
        !$.all('[data-invitee]')
          .map((el) => el.getAttribute('data-invitee'))
          .includes('anna@example.com'),
    );
    expect(await cdp.evaluate(chips)).toEqual(['tom.baker@example.com']);
    // The card: who is left, and the list as it was struck through after it.
    await cdp.waitUntil(
      ($) =>
        $.text('[data-testid="assistant-card-guests"]') ===
        'Tom Baker (tom.baker@example.com)Anna Lee (anna@example.com), Tom Baker (tom.baker@example.com)',
    );

    await cdp.clickButtonWithText('Save');
    await cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));
    await expect
      .poll(async () =>
        (await readEvents(app.userDataDir))
          .find((event) => event.title === 'Lunch')
          ?.attendees?.map((attendee) => attendee.email),
      )
      .toEqual(['tom.baker@example.com']);
  });

  it('says when no contact has a name, lets it go, and invites no one the words only mention', async () => {
    const { cdp } = app;
    await cdp.evaluate(commandN);
    await cdp.waitUntil(($) => $.text('[data-testid="editor-title"]') === 'New event');
    await phrase('Coffee | +1 | 10:00-11:00 | | invite Sarah');
    await cdp.waitUntil(hasChoices);
    expect(await cdp.evaluate(choiceText, 0)).toContain('No contact named “Sarah”');
    expect(await cdp.evaluate(chips)).toEqual([]);
    await cdp.clickTestId('draft-invitee-dismiss-0');
    await cdp.waitUntil(($) => !$.has('[data-testid="draft-invitee-choices"]'));

    // "with Anna Lee" names her, but invites no one.
    await phrase('| | 11:00-12:00 | Café with Anna Lee');
    await cdp.waitUntil(($) => $.value('input[aria-label="Start time"]') === '11:00');
    expect(await cdp.evaluate(chips)).toEqual([]);
  });
});
