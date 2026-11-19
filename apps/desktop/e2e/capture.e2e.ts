import { Account, CalendarInfo } from '@calendar/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, localIsoDaysAgo, localIsoOf, readEvents } from './harness.ts';
import type { PageKit } from './page.ts';

// Capture: a paste on the calendar (or into the ⌘K bar) becomes drafts to
// review — one thread in the editor, a hatched block per event on the
// grid. The model is the deterministic fixture, so the "email" is written
// in its grammar — `Title | +N | HH:MM-HH:MM | Location`, days relative to
// today — and nothing here depends on the date or on Apple Intelligence.
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
  events: [],
};

const TITLE = 'input[placeholder="Title"]';
// Only a capture's progress and error states show a dialog now.
const captureState = ($: PageKit) => $.el('[data-capture-state]')?.dataset.captureState ?? '';
const position = ($: PageKit) => $.text('[data-testid="draft-position"]');
const blocks = ($: PageKit) => $.count('[data-testid="draft-block"]');
const titleIs = ($: PageKit, title: string, want: string) => $.value(title) === want;

/**
 * A paste as the OS would deliver it, dispatched where `target` says: the
 * text as text/plain, or the bytes as a PNG file. Synthetic events run no
 * default action, so a single line "pasted" into the ⌘K input changes
 * nothing there — which is exactly the assertion for it.
 */
const paste = (
  $: PageKit,
  content: { readonly imageBytes: string } | { readonly text: string },
  target?: string,
) => {
  const data = new DataTransfer();
  if ('text' in content) {
    data.setData('text/plain', content.text);
  } else {
    data.items.add(
      new window.File([new window.TextEncoder().encode(content.imageBytes)], 'poster.png', {
        type: 'image/png',
      }),
    );
  }
  const into = target === undefined ? window : $.el(target)!;
  into.dispatchEvent(
    new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
  );
};

// Both on today: a "+1" event on the week's last day sits in next week,
// which the editor shows when it focuses it, taking Standup off the grid.
const MAIL = [
  'Hi all,',
  'Standup | +0 | 09:00-09:30 | Room 4',
  'Planning | +0 | 14:00-15:00',
  'Thanks!',
].join('\n');

describe('Capture from a paste', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { model: 'fixture' });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });
  afterEach(async () => {
    // A failure above must not strand a dialog or an editor for the next test.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (
        !(await app.cdp.evaluate(
          ($) => $.has('[role="dialog"]') || $.has('[data-testid="editor"]'),
        ))
      ) {
        return;
      }
      await app.cdp.escapeOrDiscard();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  });

  it('opens the events in a pasted mail as drafts of one thread; a save writes the focused one and keeps the rest', async () => {
    const { cdp } = app;
    await cdp.evaluate(paste, { text: MAIL });
    await cdp.waitUntil(($) => $.text('[data-testid="draft-position"]') === '1 of 2');
    await cdp.waitUntil(($) => $.count('[data-testid="draft-block"]') === 2);
    expect(await cdp.evaluate(captureState)).toBe('');
    await cdp.waitUntil(titleIs, TITLE, 'Standup');

    await cdp.clickButtonWithText('Save');
    // The next draft takes the form; the thread is down to it.
    await cdp.waitUntil(titleIs, TITLE, 'Planning');
    expect(await cdp.evaluate(position)).toBe('');
    await cdp.waitUntil(($) => $.count('[data-testid="draft-block"]') === 1);
    await expect
      .poll(async () => {
        const events = await readEvents(app.userDataDir);
        return events.find((event) => event.title === 'Standup');
      })
      .toMatchObject({ calendarId: 'cal-e2e', isAllDay: false, location: 'Room 4' });
    const saved = (await readEvents(app.userDataDir)).find((event) => event.title === 'Standup')!;
    // `+0` in the fixture grammar is today in the app's zone: the local
    // date of the stored instant (its UTC date is yesterday's more than
    // nine hours ahead of UTC).
    expect(localIsoOf(saved.startUtc)).toBe(localIsoDaysAgo(0));
    // The other draft is unsaved: Cancel asks first.
    await cdp.clickButtonWithText('Cancel');
    await cdp.answerDiscard(true);
    await cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));
    expect((await readEvents(app.userDataDir)).some((event) => event.title === 'Planning')).toBe(
      false,
    );
    // On the grid, too, as a stored event now. Back to today first: the
    // second draft's day was revealed, which on a Sunday is next week.
    await cdp.clickButtonWithText('Today');
    await cdp.locate('[title^="Standup ·"]');
  });

  it('opens the editor directly for a single event, as a thread of one', async () => {
    const { cdp } = app;
    await cdp.evaluate(paste, { text: 'Dentist | +3 | 14:30' });
    await cdp.waitUntil(titleIs, TITLE, 'Dentist');
    expect(await cdp.evaluate(captureState)).toBe('');
    expect(await cdp.evaluate(position)).toBe('');
    await cdp.waitUntil(($) => $.count('[data-testid="draft-block"]') === 1);
    // A capture's draft is unsaved, untouched as it is: Cancel asks first.
    await cdp.clickButtonWithText('Cancel');
    await cdp.answerDiscard(true);
    await cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));
    expect((await readEvents(app.userDataDir)).some((event) => event.title === 'Dentist')).toBe(
      false,
    );
  });

  it('reads a pasted image through text recognition', async () => {
    const { cdp } = app;
    await cdp.evaluate(paste, {
      imageBytes: 'Keynote | +2 | 10:00-11:00 | Hall A\nWorkshop | +2 | 13:00-16:00',
    });
    await cdp.waitUntil(($) => $.text('[data-testid="draft-position"]') === '1 of 2');
    await cdp.waitUntil(titleIs, TITLE, 'Keynote');
    await cdp.discardEditor();
  });

  it('leaves a single-line paste to the ⌘K input and takes a multi-line one from it', async () => {
    const { cdp } = app;
    // CDP key events don't carry macOS meta reliably: dispatch ⌘K to the
    // app's own window listener.
    const commandK = () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    };
    const INPUT = '[data-testid="quick-add-input"]';
    await cdp.evaluate(commandK);
    await cdp.waitUntil(($, input: string) => document.activeElement === $.el(input), INPUT);
    // Escape leaves the field; ⌘K takes it back.
    await cdp.pressEscape();
    await cdp.waitUntil(($, input: string) => document.activeElement !== $.el(input), INPUT);
    await cdp.evaluate(commandK);
    await cdp.waitUntil(($, input: string) => document.activeElement === $.el(input), INPUT);
    await cdp.evaluate(paste, { text: 'Lunch | +1 | 12:00' }, INPUT);
    // Nothing happened: no capture, no draft, the field keeps focus.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await cdp.evaluate(captureState)).toBe('');
    expect(await cdp.evaluate(blocks)).toBe(0);
    expect(
      await cdp.evaluate(($, input: string) => document.activeElement === $.el(input), INPUT),
    ).toBe(true);

    await cdp.evaluate(paste, { text: MAIL }, INPUT);
    // The field handed the paste to capture, which reopened the editor on the thread.
    await cdp.waitUntil(($) => $.text('[data-testid="draft-position"]') === '1 of 2');
    await cdp.waitUntil(titleIs, TITLE, 'Standup');
    await cdp.discardEditor();
  });
});
