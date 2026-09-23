import { Account, CalendarInfo, EventRecord, PendingOp } from '@calendar/core';
import type { GoogleFixture } from '@calendar/sync/testing/googleFixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type App, launchApp, readEvents, readPendingOps } from './harness.ts';

// Two edits a 412 parked (Google's copy moved on while they were queued),
// against the fake Google API: the banner names the event and shows what
// differs, "Take theirs" loads Google's current copy, "Keep mine" re-sends
// the edit without If-Match. Seeded relative to now — date-independent.
const POLL = { timeout: 15_000 };
const HOUR = 60 * 60 * 1000;
const start = Math.floor(Date.now() / HOUR) * HOUR + 2 * HOUR;

const serverEvent = (id: string, summary: string) => ({
  end: { dateTime: new Date(start + HOUR).toISOString() },
  id,
  start: { dateTime: new Date(start).toISOString() },
  status: 'confirmed',
  summary,
});

const googleFixture: GoogleFixture = {
  accounts: [{ email: 'e2e@nikgraf.com', id: 'acc-e2e', tasksEnabled: false }],
  calendars: [{ accessRole: 'owner', id: 'cal-e2e', primary: true, summary: 'Work' }],
  events: {
    'cal-e2e': [
      serverEvent('evt-theirs', 'Budget review (Google)'),
      serverEvent('evt-mine', 'Offsite (Google)'),
    ],
  },
};

/** The local row as the app left it: the user's version, still pending. */
const localRow = (id: string, title: string) =>
  new EventRecord({
    accountId: 'acc-e2e',
    calendarId: 'cal-e2e',
    endUtc: start + HOUR,
    etag: '"stale"',
    id,
    isAllDay: false,
    startUtc: start,
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'pending',
    title,
    updatedAt: 2,
  });

const parkedUpdate = (id: string, createdAt: number, mine: EventRecord, theirs: string) =>
  new PendingOp({
    accountId: 'acc-e2e',
    attempts: 0,
    baseEtag: '"stale"',
    calendarId: 'cal-e2e',
    conflictAt: createdAt,
    createdAt,
    eventId: mine.id,
    id,
    kind: 'update',
    lastError: 'changed on Google',
    nextAttemptAt: 0,
    payload: mine,
    serverPayload: new EventRecord({ ...mine, etag: '"v1"', syncStatus: 'synced', title: theirs }),
  });

const theirsRow = localRow('evt-theirs', 'Budget review (mine)');
const mineRow = localRow('evt-mine', 'Offsite (mine)');

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
      timeZone: 'UTC',
    }),
  ],
  events: [theirsRow, mineRow],
  pendingOps: [
    parkedUpdate('op-theirs', 10, theirsRow, 'Budget review (Google)'),
    parkedUpdate('op-mine', 20, mineRow, 'Offsite (Google)'),
  ],
};

const banner = `document.querySelector('[data-testid="conflict-banner"]')?.textContent ?? ''`;
const eventTitle = async (app: App, id: string) =>
  (await readEvents(app.userDataDir)).find((event) => event.id === id);

describe('Sync conflicts', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { google: { fixture: googleFixture } });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  it('names the event, shows what differs, and take theirs loads Google’s copy', async () => {
    await app.cdp.waitFor(`(${banner}).includes('Budget review (mine)')`);
    const text = await app.cdp.eval<string>(banner);
    expect(text).toContain('changed on Google while your edit waited');
    expect(text).toContain('Budget review (Google)');
    expect(text).toContain('+1 more');
    // A pull while parked must not have replaced the user's version.
    expect((await eventTitle(app, 'evt-theirs'))?.title).toBe('Budget review (mine)');

    await app.cdp.clickButtonWithText('Take theirs');
    await expect
      .poll(() => eventTitle(app, 'evt-theirs'), POLL)
      .toMatchObject({ syncStatus: 'synced', title: 'Budget review (Google)' });
    await expect
      .poll(async () => (await readPendingOps(app.userDataDir)).map((op) => op.id), POLL)
      .toEqual(['op-mine']);
  });

  it('keep mine re-sends the edit and the queue drains', async () => {
    await app.cdp.waitFor(`(${banner}).includes('Offsite (mine)')`);
    await app.cdp.clickButtonWithText('Keep mine');
    await expect.poll(async () => (await readPendingOps(app.userDataDir)).length, POLL).toBe(0);
    // The patch response acked the row with the user's title.
    await expect
      .poll(() => eventTitle(app, 'evt-mine'), POLL)
      .toMatchObject({ syncStatus: 'synced', title: 'Offsite (mine)' });
    await app.cdp.waitFor(`!document.querySelector('[data-testid="conflict-banner"]')`);
  });
});
