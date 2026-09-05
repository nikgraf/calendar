import { Account, Attendee, CalendarInfo, EventRecord, GoogleContact } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type App, launchApp, readPendingOps } from './harness.ts';

// Contact suggestions come from Google People rows seeded straight into
// SQLite: the harness launches with CALENDAR_CONTACTS=off, so the device
// address book is never read and no TCC prompt can fire. This covers the
// combobox — typeahead, keyboard selection, free-typed addresses, chips —
// and that saving sends the attendee list through the queue.
const HOUR_MS = 60 * 60 * 1000;
const todayAt = (hour: number): number => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour);
};

const seed = {
  accounts: [
    new Account({
      contactsEnabled: true,
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
      summary: 'Work',
      timeZone: 'UTC',
    }),
  ],
  contacts: [
    new GoogleContact({
      accountId: 'acc-e2e',
      displayName: 'Alice Example',
      email: 'alice@example.com',
      isOther: false,
      resourceName: 'people/c1',
    }),
    new GoogleContact({
      accountId: 'acc-e2e',
      displayName: 'Alistair Other',
      email: 'alistair@example.com',
      isOther: true,
      resourceName: 'otherContacts/o1',
    }),
    new GoogleContact({
      accountId: 'acc-e2e',
      email: 'carol@example.com',
      isOther: false,
      resourceName: 'people/c2',
    }),
  ],
  events: [
    new EventRecord({
      accountId: 'acc-e2e',
      attendees: [
        new Attendee({ email: 'e2e@nikgraf.com', isOrganizer: true, responseStatus: 'accepted' }),
      ],
      calendarId: 'cal-work',
      endUtc: todayAt(13) + HOUR_MS,
      etag: '"r-1"',
      id: 'evt-planning',
      isAllDay: false,
      startTimeZone: 'UTC',
      startUtc: todayAt(13),
      status: 'confirmed',
      syncedAt: 1,
      syncStatus: 'synced',
      title: 'Planning session',
      updatedAt: 1,
    }),
  ],
};

const INPUT = `document.querySelector('input[aria-label="Invitees"]')`;

describe('invitee combobox', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed);
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  const typeInvitee = async (text: string) => {
    await app.cdp.eval(`(() => {
      const input = ${INPUT};
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  };
  const pressKey = (key: string) =>
    app.cdp.eval(
      `${INPUT}.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`,
    );
  const chips = () =>
    app.cdp.eval<Array<string>>(
      `[...document.querySelectorAll('[data-invitee]')].map((el) => el.getAttribute('data-invitee'))`,
    );

  it('suggests seeded contacts, ranks saved above other, and adds by keyboard', async () => {
    const { cdp } = app;
    const block = await cdp.locate('[title^="Planning session"]');
    await cdp.click(block.x, block.y);
    await cdp.waitFor(`document.body.textContent.includes('Invitees')`);
    // The organizer is already a chip and cannot be removed.
    expect(await chips()).toEqual(['e2e@nikgraf.com']);
    expect(
      await cdp.eval(`!!document.querySelector('[aria-label="Remove e2e@nikgraf.com"]')`),
    ).toBe(false);

    await cdp.eval(`${INPUT}.focus()`);
    await typeInvitee('ali');
    await cdp.waitFor(`document.querySelectorAll('[role="option"]').length === 2`);
    const options = await cdp.eval<Array<string>>(
      `[...document.querySelectorAll('[role="option"]')].map((el) => el.textContent)`,
    );
    expect(options[0]).toContain('Alice Example');
    expect(options[1]).toContain('Alistair Other');

    // ArrowDown moves the highlight to the second row; Enter takes it.
    await pressKey('ArrowDown');
    await pressKey('Enter');
    await cdp.waitFor(`document.querySelectorAll('[data-invitee]').length === 2`);
    expect(await chips()).toEqual(['e2e@nikgraf.com', 'alistair@example.com']);
    // Chosen guests drop out of the suggestions.
    await typeInvitee('ali');
    await cdp.waitFor(`document.querySelectorAll('[role="option"]').length === 1`);
    await typeInvitee('');
  });

  it('accepts a free-typed address on Enter and removes chips', async () => {
    const { cdp } = app;
    await typeInvitee('bob@example.com');
    await cdp.waitFor(`document.body.textContent.includes('Press Enter to invite this address')`);
    await pressKey('Enter');
    await cdp.waitFor(`document.querySelectorAll('[data-invitee]').length === 3`);
    expect(await chips()).toContain('bob@example.com');
    await cdp.eval(`document.querySelector('[aria-label="Remove alistair@example.com"]').click()`);
    await cdp.waitFor(`document.querySelectorAll('[data-invitee]').length === 2`);
    expect(await chips()).toEqual(['e2e@nikgraf.com', 'bob@example.com']);
  });

  it('saves the guest list as an update op that keeps the organizer intact', async () => {
    const { cdp } = app;
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!document.body.textContent.includes('Invitees')`);
    await expect
      .poll(async () => {
        const ops = await readPendingOps(app.userDataDir);
        return ops.find((op) => op.kind === 'update' && op.eventId === 'evt-planning')?.payload
          ?.attendees;
      })
      .toEqual([
        expect.objectContaining({
          email: 'e2e@nikgraf.com',
          isOrganizer: true,
          responseStatus: 'accepted',
        }),
        expect.objectContaining({ email: 'bob@example.com', responseStatus: 'needsAction' }),
      ]);
  });
});
