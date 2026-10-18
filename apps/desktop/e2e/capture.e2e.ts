import { Account, CalendarInfo } from '@calendar/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, localIsoDaysAgo, readEvents } from './harness.ts';

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
// Parenthesised: `??` binds looser than `===`, so an unwrapped expression
// compared in a waitFor would be truthy as soon as the element existed.
// Only a capture's progress and error states show a dialog now.
const STATE = `(document.querySelector('[data-capture-state]')?.dataset.captureState ?? '')`;
const EDITOR = `!!document.querySelector('[data-testid="editor"]')`;
const position = `(document.querySelector('[data-testid="draft-position"]')?.textContent ?? '')`;
const blocks = `document.querySelectorAll('[data-testid="draft-block"]').length`;
const titleIs = (title: string) =>
  `document.querySelector(${JSON.stringify(TITLE)})?.value === ${JSON.stringify(title)}`;

/**
 * A paste as the OS would deliver it, dispatched where `target` says: the
 * text as text/plain, or the bytes as a PNG file. Synthetic events run no
 * default action, so a single line "pasted" into the ⌘K input changes
 * nothing there — which is exactly the assertion for it.
 */
const paste = (
  content: { readonly imageBytes: string } | { readonly text: string },
  target = 'window',
) => `(() => {
  const data = new DataTransfer();
  ${
    'text' in content
      ? `data.setData('text/plain', ${JSON.stringify(content.text)});`
      : `data.items.add(new File([new TextEncoder().encode(${JSON.stringify(content.imageBytes)})], 'poster.png', { type: 'image/png' }));`
  }
  const target = ${target};
  target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
})()`;

const MAIL = [
  'Hi all,',
  'Standup | +0 | 09:00-09:30 | Room 4',
  'Planning | +1 | 14:00-15:00',
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
        !(await app.cdp.eval<boolean>(`!!document.querySelector('[role="dialog"]') || ${EDITOR}`))
      ) {
        return;
      }
      await app.cdp.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  });

  it('opens the events in a pasted mail as drafts of one thread; a save writes the focused one and keeps the rest', async () => {
    const { cdp } = app;
    await cdp.eval(paste({ text: MAIL }));
    await cdp.waitFor(`${position} === '1 of 2'`);
    await cdp.waitFor(`${blocks} === 2`);
    expect(await cdp.eval<string>(STATE)).toBe('');
    await cdp.waitFor(titleIs('Standup'));

    await cdp.clickButtonWithText('Save');
    // The next draft takes the form; the thread is down to it.
    await cdp.waitFor(titleIs('Planning'));
    expect(await cdp.eval<string>(position)).toBe('');
    await cdp.waitFor(`${blocks} === 1`);
    await expect
      .poll(async () => {
        const events = await readEvents(app.userDataDir);
        return events.find((event) => event.title === 'Standup');
      })
      .toMatchObject({ calendarId: 'cal-e2e', isAllDay: false, location: 'Room 4' });
    const saved = (await readEvents(app.userDataDir)).find((event) => event.title === 'Standup')!;
    // `+0` in the fixture grammar is today in the app's zone.
    expect(new Date(saved.startUtc).toISOString().slice(0, 10)).toBe(localIsoDaysAgo(0));
    await cdp.clickButtonWithText('Cancel');
    await cdp.waitFor(`!${EDITOR}`);
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
    await cdp.eval(paste({ text: 'Dentist | +3 | 14:30' }));
    await cdp.waitFor(titleIs('Dentist'));
    expect(await cdp.eval<string>(STATE)).toBe('');
    expect(await cdp.eval<string>(position)).toBe('');
    await cdp.waitFor(`${blocks} === 1`);
    await cdp.clickButtonWithText('Cancel');
    await cdp.waitFor(`!${EDITOR}`);
    expect((await readEvents(app.userDataDir)).some((event) => event.title === 'Dentist')).toBe(
      false,
    );
  });

  it('reads a pasted image through text recognition', async () => {
    const { cdp } = app;
    await cdp.eval(
      paste({ imageBytes: 'Keynote | +2 | 10:00-11:00 | Hall A\nWorkshop | +2 | 13:00-16:00' }),
    );
    await cdp.waitFor(`${position} === '1 of 2'`);
    await cdp.waitFor(titleIs('Keynote'));
    await cdp.pressEscape();
    await cdp.waitFor(`!${EDITOR}`);
  });

  it('leaves a single-line paste to the ⌘K input and takes a multi-line one from it', async () => {
    const { cdp } = app;
    // CDP key events don't carry macOS meta reliably: dispatch ⌘K to the
    // app's own window listener.
    const commandK = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))`;
    const INPUT = `document.querySelector('[data-testid="quick-add-input"]')`;
    await cdp.eval(commandK);
    await cdp.waitFor(`document.activeElement === ${INPUT}`);
    // Escape leaves the field; ⌘K takes it back.
    await cdp.pressEscape();
    await cdp.waitFor(`document.activeElement !== ${INPUT}`);
    await cdp.eval(commandK);
    await cdp.waitFor(`document.activeElement === ${INPUT}`);
    await cdp.eval(paste({ text: 'Lunch | +1 | 12:00' }, INPUT));
    // Nothing happened: no capture, no draft, the field keeps focus.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await cdp.eval<string>(STATE)).toBe('');
    expect(await cdp.eval<number>(blocks)).toBe(0);
    expect(await cdp.eval<boolean>(`document.activeElement === ${INPUT}`)).toBe(true);

    await cdp.eval(paste({ text: MAIL }, INPUT));
    // The field handed the paste to capture, which reopened the editor on the thread.
    await cdp.waitFor(`${position} === '1 of 2'`);
    await cdp.waitFor(titleIs('Standup'));
    await cdp.pressEscape();
    await cdp.waitFor(`!${EDITOR}`);
  });
});
