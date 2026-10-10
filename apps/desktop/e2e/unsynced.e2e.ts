import { Account, CalendarInfo, EventRecord, PendingOp } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readEvents, readPendingOps } from './harness.ts';

// The unsynced-changes list in the sidebar footer: a row expands to what
// the change does, field by field, and "Discard change" there puts the
// event back as it was before the edit. Seeded as the app leaves an edit
// made offline — the row edited and pending, the op carrying the row it
// replaced — plus a parked 412, whose panel shows both versions. The
// account has no token, so nothing is pushed. Date-independent: the event
// sits two hours from now.
const POLL = { timeout: 15_000 };
const HOUR = 60 * 60 * 1000;
const start = Math.floor(Date.now() / HOUR) * HOUR + 2 * HOUR;

const row = (id: string, title: string, overrides: Partial<EventRecord> = {}) =>
  new EventRecord({
    accountId: 'acc-e2e',
    calendarId: 'cal-e2e',
    endUtc: start + HOUR,
    etag: '"v1"',
    id,
    isAllDay: false,
    startUtc: start,
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    title,
    updatedAt: 1,
    ...overrides,
  });

const acked = row('evt-edit', 'Budget review');
const edited = row('evt-edit', 'Budget review (moved)', {
  endUtc: start + 2 * HOUR,
  location: 'Room 4',
  startUtc: start + HOUR,
  syncStatus: 'pending',
  updatedAt: 2,
});
const parkedMine = row('evt-park', 'Offsite (mine)', { syncStatus: 'pending', updatedAt: 2 });

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
      timeZone: 'UTC',
    }),
  ],
  events: [edited, parkedMine],
  pendingOps: [
    new PendingOp({
      accountId: 'acc-e2e',
      attempts: 0,
      baseEtag: '"v1"',
      beforePayload: acked,
      calendarId: 'cal-e2e',
      createdAt: 10,
      eventId: 'evt-edit',
      id: 'op-edit',
      kind: 'update',
      nextAttemptAt: 0,
      payload: edited,
    }),
    new PendingOp({
      accountId: 'acc-e2e',
      attempts: 0,
      baseEtag: '"v1"',
      beforePayload: row('evt-park', 'Offsite'),
      calendarId: 'cal-e2e',
      conflictAt: 20,
      createdAt: 20,
      eventId: 'evt-park',
      id: 'op-park',
      kind: 'update',
      lastError: 'changed on Google',
      nextAttemptAt: 0,
      payload: parkedMine,
      serverPayload: row('evt-park', 'Offsite (Google)', { etag: '"v2"' }),
    }),
  ],
};

const panel = `document.querySelector('[data-testid="pending-op-change"]')?.textContent ?? ''`;

describe('Unsynced changes', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed);
    await app.cdp.waitFor(`document.body.textContent.includes('unsynced change')`);
    await app.cdp.eval(
      `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('unsynced change'))?.click()`,
    );
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  it('a row expands to what the edit changed, and discarding it puts the event back', async () => {
    await app.cdp.clickTestId('pending-op-op-edit');
    await app.cdp.waitFor(`(${panel}).includes('Budget review (moved)')`);
    const text = await app.cdp.eval<string>(panel);
    // Before and after, field by field — only the fields that differ.
    expect(text).toContain('Title');
    expect(text).toContain('Budget review');
    expect(text).toContain('Time');
    expect(text).toContain('Location');
    expect(text).toContain('Room 4');
    expect(text).not.toContain('Notes');

    await app.cdp.clickTestId('pending-op-discard');
    await expect
      .poll(async () => (await readPendingOps(app.userDataDir)).map((op) => op.id), POLL)
      .toEqual(['op-park']);
    const event = (await readEvents(app.userDataDir)).find((entry) => entry.id === 'evt-edit');
    expect(event).toMatchObject({
      location: undefined,
      startUtc: start,
      syncStatus: 'synced',
      title: 'Budget review',
    });
    // The grid repaints from the restored row.
    await app.cdp.waitFor(`!!document.querySelector('[title^="Budget review"]')`);
    await app.cdp.waitFor(`!document.querySelector('[title^="Budget review (moved)"]')`);
  });

  it('a parked change shows both versions and offers the choice', async () => {
    await app.cdp.clickTestId('pending-op-op-park');
    await app.cdp.waitFor(`(${panel}).includes('Offsite (Google)')`);
    const text = await app.cdp.eval<string>(panel);
    expect(text).toContain('Offsite (mine)');
    expect(text).toContain('Keep mine');
    expect(text).toContain('Take theirs');
    expect(text).not.toContain('Discard change');
  });
});
