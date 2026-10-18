import { Account, CalendarInfo, GoogleContact } from '@calendar/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readEvents } from './harness.ts';

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

const INPUT = '[data-testid="quick-add-input"]';
// CDP key events don't carry macOS meta reliably: dispatch ⌘N to the app's own window listener.
const COMMAND_N = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }))`;
const chips = `[...document.querySelectorAll('[data-invitee]')].map((el) => el.getAttribute('data-invitee'))`;
const newestSummary = `document.querySelector('[data-testid="draft-turn-summary"]')?.textContent ?? ''`;
const choiceText = (index: number) =>
  `document.querySelector('[data-testid="draft-invitee-choice-${String(index)}"]')?.textContent ?? ''`;
const hasChoices = `!!document.querySelector('[data-testid="draft-invitee-choices"]')`;

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
      if (!(await app.cdp.eval<boolean>(`!!document.querySelector('[data-testid="editor"]')`))) {
        return;
      }
      await app.cdp.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  });

  const phrase = async (text: string) => {
    await app.cdp.type(INPUT, text);
    await app.cdp.clickTestId('quick-add-apply');
  };

  it('invites the one contact a name means, asks which for two, takes a guest off, and saves them', async () => {
    const { cdp } = app;
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(
      `document.querySelector('[data-testid="editor-title"]')?.textContent === 'New event'`,
    );
    await phrase('Lunch | +2 | 13:00-14:00 | | invite Anna Lee and Tom');
    // Anna Lee is one contact: a guest. Tom is two: a question, nothing picked.
    await cdp.waitFor(`${chips}.includes('anna@example.com')`);
    expect(await cdp.eval<Array<string>>(chips)).toEqual(['anna@example.com']);
    await cdp.waitFor(hasChoices);
    expect(await cdp.eval<string>(choiceText(0))).toContain('Which Tom?');
    expect(await cdp.eval<string>(choiceText(0))).toContain('Tom Baker');
    expect(await cdp.eval<string>(choiceText(0))).toContain('Tom Lee');
    expect(await cdp.eval<string>(newestSummary)).toContain('invites Anna Lee');
    expect(await cdp.eval<string>(newestSummary)).toContain('which Tom?');

    // A pick makes that contact a guest; the question goes.
    await cdp.clickTestId('draft-invitee-pick-0-0');
    await cdp.waitFor(`${chips}.includes('tom.baker@example.com')`);
    await cdp.waitFor(`!${hasChoices}`);

    // A later phrase takes a guest off by name.
    await phrase('remove Anna');
    await cdp.waitFor(`!${chips}.includes('anna@example.com')`);
    expect(await cdp.eval<Array<string>>(chips)).toEqual(['tom.baker@example.com']);
    expect(await cdp.eval<string>(newestSummary)).toContain('uninvites Anna Lee');

    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!document.querySelector('[data-testid="editor"]')`);
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
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(
      `document.querySelector('[data-testid="editor-title"]')?.textContent === 'New event'`,
    );
    await phrase('Coffee | +1 | 10:00-11:00 | | invite Sarah');
    await cdp.waitFor(hasChoices);
    expect(await cdp.eval<string>(choiceText(0))).toContain('No contact named “Sarah”');
    expect(await cdp.eval<Array<string>>(chips)).toEqual([]);
    await cdp.clickTestId('draft-invitee-dismiss-0');
    await cdp.waitFor(`!${hasChoices}`);

    // "with Anna Lee" names her, but invites no one.
    await phrase('| | 11:00-12:00 | Café with Anna Lee');
    await cdp.waitFor(
      `document.querySelector('input[aria-label="Start time"]')?.value === '11:00'`,
    );
    expect(await cdp.eval<Array<string>>(chips)).toEqual([]);
  });
});
