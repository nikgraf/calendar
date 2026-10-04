import { Account, CalendarInfo } from '@calendar/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type App, launchApp, localIsoDaysAgo, readEvents } from './harness.ts';

// Capture: a paste on the calendar (or into the ⌘K bar) becomes events to
// review. The model is the deterministic fixture, so the "email" is written
// in its grammar — `Title | +N | HH:MM-HH:MM | Location`, days relative to
// today — and nothing here depends on the date or on Apple Intelligence.
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
const STATE = `(document.querySelector('[data-capture-state]')?.dataset.captureState ?? '')`;
const rowStatus = (id: string) =>
  `(document.querySelector('[data-capture-row="${id}"]')?.dataset.status ?? '')`;

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
    // A failure above must not strand a dialog for the next test.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await app.cdp.eval<boolean>(`!!document.querySelector('[role="dialog"]')`))) {
        return;
      }
      await app.cdp.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  });

  it('lists the events in a pasted mail, and a row opens the editor whose save marks it added', async () => {
    const { cdp } = app;
    await cdp.eval(paste({ text: MAIL }));
    await cdp.waitFor(`${STATE} === 'review'`);
    expect(await cdp.eval<string>(`document.body.textContent`)).toContain('2 events found');
    expect(await cdp.eval<string>(rowStatus('capture-0'))).toBe('open');
    expect(await cdp.eval<string>(rowStatus('capture-1'))).toBe('open');
    // The row's text is what the user checks before opening it.
    expect(
      await cdp.eval<string>(
        `document.querySelector('[data-capture-row="capture-0"]').textContent`,
      ),
    ).toContain('Room 4');

    const row = await cdp.locate('[data-capture-row="capture-0"]');
    await cdp.click(row.x, row.y);
    // The list steps aside for the editor: one Escape must close one dialog.
    await cdp.waitFor(`!document.querySelector('[data-capture-state]')`);
    await cdp.waitFor(`document.querySelector(${JSON.stringify(TITLE)})?.value === 'Standup'`);
    await cdp.clickButtonWithText('Save');

    await cdp.waitFor(`${rowStatus('capture-0')} === 'added'`);
    expect(await cdp.eval<string>(rowStatus('capture-1'))).toBe('open');
    await expect
      .poll(async () => {
        const events = await readEvents(app.userDataDir);
        return events.find((event) => event.title === 'Standup');
      })
      .toMatchObject({ calendarId: 'cal-e2e', isAllDay: false, location: 'Room 4' });
    const saved = (await readEvents(app.userDataDir)).find((event) => event.title === 'Standup')!;
    // `+0` in the fixture grammar is today in the app's zone.
    expect(new Date(saved.startUtc).toISOString().slice(0, 10)).toBe(localIsoDaysAgo(0));
    await cdp.clickButtonWithText('Close');
    await cdp.waitFor(`${STATE} === ''`);
    // On the grid, too (the dialog's backdrop would have blocked the hit-test).
    await cdp.locate('[title^="Standup ·"]');
  });

  it('opens the editor directly for a single event, with the list skipped', async () => {
    const { cdp } = app;
    await cdp.eval(paste({ text: 'Dentist | +3 | 14:30' }));
    await cdp.waitFor(`document.querySelector(${JSON.stringify(TITLE)})?.value === 'Dentist'`);
    expect(await cdp.eval<string>(STATE)).toBe('');
    await cdp.clickButtonWithText('Cancel');
    await cdp.waitFor(`!document.querySelector(${JSON.stringify(TITLE)})`);
    expect((await readEvents(app.userDataDir)).some((event) => event.title === 'Dentist')).toBe(
      false,
    );
  });

  it('reads a pasted image through text recognition', async () => {
    const { cdp } = app;
    await cdp.eval(
      paste({ imageBytes: 'Keynote | +2 | 10:00-11:00 | Hall A\nWorkshop | +2 | 13:00-16:00' }),
    );
    await cdp.waitFor(`${STATE} === 'review'`);
    expect(await cdp.eval<string>(`document.body.textContent`)).toContain('Hall A');
    await cdp.pressEscape();
    await cdp.waitFor(`${STATE} === ''`);
  });

  it('leaves a single-line paste to the ⌘K input and takes a multi-line one from it', async () => {
    const { cdp } = app;
    await cdp.eval(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))`,
    );
    const INPUT = `document.querySelector('input[placeholder="Lunch with Sarah tomorrow at 1"]')`;
    await cdp.waitFor(`!!${INPUT}`);
    await cdp.eval(paste({ text: 'Lunch | +1 | 12:00' }, INPUT));
    // Nothing happened: no capture, the bar is still open.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await cdp.eval<string>(STATE)).toBe('');
    expect(await cdp.eval<boolean>(`!!${INPUT}`)).toBe(true);

    await cdp.eval(paste({ text: MAIL }, INPUT));
    await cdp.waitFor(`${STATE} === 'review'`);
    expect(await cdp.eval<boolean>(`!!${INPUT}`)).toBe(false);
    await cdp.pressEscape();
    await cdp.waitFor(`${STATE} === ''`);
  });
});
