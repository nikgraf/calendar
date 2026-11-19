import { Account, Attendee, CalendarInfo, EventRecord, GoogleContact } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, localDayAt, readPendingOps } from './harness.ts';

// Contact suggestions come from Google People rows seeded straight into
// SQLite: the harness launches with CALENDAR_CONTACTS=off, so the device
// address book is never read and no TCC prompt can fire. This covers the
// combobox — typeahead, keyboard selection, free-typed addresses, chips —
// and that saving sends the attendee list through the queue.
const HOUR_MS = 60 * 60 * 1000;
/** Today at the given local hour. */
const todayAt = (hour: number): number => localDayAt(0, hour);

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
      colorHex: '#4285f4',
      id: 'cal-work',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
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
        new Attendee({ email: 'e2e@example.com', isOrganizer: true, responseStatus: 'accepted' }),
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

const INPUT = 'input[aria-label="Invitees"]';

describe('invitee combobox', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed);
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  const typeInvitee = async (text: string) => {
    await app.cdp.evaluate(
      ($, input: string, value: string) => $.setValue(input, value),
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
  const chips = () =>
    app.cdp.evaluate(($) => $.all('[data-invitee]').map((el) => el.getAttribute('data-invitee')));

  it('suggests seeded contacts, ranks saved above other, and adds by keyboard', async () => {
    const { cdp } = app;
    await cdp.openEditor('[title^="Planning session"]');
    await cdp.waitUntil(() => document.body.textContent.includes('Invitees'));
    // The organizer is already a chip and cannot be removed.
    expect(await chips()).toEqual(['e2e@example.com']);
    expect(await cdp.evaluate(($) => $.has('[aria-label="Remove e2e@example.com"]'))).toBe(false);

    await cdp.evaluate(($, input: string) => {
      $.el(input)!.focus();
    }, INPUT);
    await typeInvitee('ali');
    await cdp.waitUntil(($) => $.count('[role="option"]') === 2);
    const options = await cdp.evaluate(($) => $.all('[role="option"]').map((el) => el.textContent));
    expect(options[0]).toContain('Alice Example');
    expect(options[1]).toContain('Alistair Other');

    // ArrowDown moves the highlight to the second row; Enter takes it.
    await pressKey('ArrowDown');
    await pressKey('Enter');
    await cdp.waitUntil(($) => $.count('[data-invitee]') === 2);
    expect(await chips()).toEqual(['e2e@example.com', 'alistair@example.com']);
    // Chosen guests drop out of the suggestions.
    await typeInvitee('ali');
    await cdp.waitUntil(($) => $.count('[role="option"]') === 1);
    await typeInvitee('');
  });

  it('accepts a free-typed address on Enter and removes chips', async () => {
    const { cdp } = app;
    await typeInvitee('bob@example.com');
    await cdp.waitUntil(() =>
      document.body.textContent.includes('Press Enter to invite this address'),
    );
    await pressKey('Enter');
    await cdp.waitUntil(($) => $.count('[data-invitee]') === 3);
    expect(await chips()).toContain('bob@example.com');
    await cdp.evaluate(($) => {
      $.el('[aria-label="Remove alistair@example.com"]')!.click();
    });
    await cdp.waitUntil(($) => $.count('[data-invitee]') === 2);
    expect(await chips()).toEqual(['e2e@example.com', 'bob@example.com']);
  });

  it('saves the guest list as an update op that keeps the organizer intact', async () => {
    const { cdp } = app;
    await cdp.clickButtonWithText('Save');
    await cdp.waitUntil(() => !document.body.textContent.includes('Invitees'));
    await expect
      .poll(async () => {
        const ops = await readPendingOps(app.userDataDir);
        return ops.find((op) => op.kind === 'update' && op.eventId === 'evt-planning')?.payload
          ?.attendees;
      })
      .toEqual([
        expect.objectContaining({
          email: 'e2e@example.com',
          isOrganizer: true,
          responseStatus: 'accepted',
        }),
        expect.objectContaining({ email: 'bob@example.com', responseStatus: 'needsAction' }),
      ]);
  });
});
