import {
  Account,
  APPLE_REMINDERS_ACCOUNT_ID,
  CalendarInfo,
  EventRecord,
  PendingOp,
  TaskListInfo,
  TaskRecord,
} from '@calendar/core';
import type { GoogleFixture } from '@calendar/sync/testing/googleFixture';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, localIsoDaysAgo, readEvents, readPendingOps } from './harness.ts';

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

// ---------------------------------------------------------------------------
// The notice stack: the conflict banner, a change Google refused and a
// failed write shown together, in a window as wide as CI's screen. A parked
// edit (the banner), a move Google answers with a 403 (the queue drops it:
// the dropped-change toast) and a reminder that cannot be completed without
// the Reminders bridge (the failed-write toast). The events sit at fixed
// hours of this machine's today, so the week view always shows them.
// ---------------------------------------------------------------------------

/** `hour`:00 on this machine's today. */
const todayAt = (hour: number): number => {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
};
const parkedStart = todayAt(10);

const noticesFixture: GoogleFixture = {
  accounts: [{ email: 'e2e@nikgraf.com', id: 'acc-e2e', tasksEnabled: false }],
  calendars: [
    { accessRole: 'owner', id: 'cal-e2e', primary: true, summary: 'Work' },
    { accessRole: 'owner', id: 'cal-other', summary: 'Other' },
  ],
  events: {
    'cal-e2e': [
      {
        end: { dateTime: new Date(parkedStart + HOUR).toISOString() },
        id: 'evt-park',
        start: { dateTime: new Date(parkedStart).toISOString() },
        status: 'confirmed',
        summary: 'Budget review (Google)',
      },
      // No organizer: Google refuses to move it, a 4xx the queue drops.
      {
        end: { dateTime: new Date(todayAt(13) + HOUR).toISOString() },
        id: 'evt-move',
        start: { dateTime: new Date(todayAt(13)).toISOString() },
        status: 'confirmed',
        summary: 'Move me',
      },
    ],
  },
};

const parkedRow = new EventRecord({
  ...localRow('evt-park', 'Budget review (mine)'),
  endUtc: parkedStart + HOUR,
  startUtc: parkedStart,
});

const noticesSeed = {
  accounts: [
    ...seed.accounts,
    new Account({
      contactsEnabled: false,
      createdAt: 2,
      displayName: 'Apple Reminders',
      email: '',
      id: APPLE_REMINDERS_ACCOUNT_ID,
      provider: 'apple',
      status: 'ok',
      tasksEnabled: true,
    }),
  ],
  calendars: [
    ...seed.calendars,
    new CalendarInfo({
      accessRole: 'owner',
      accountId: 'acc-e2e',
      colorHex: '#16a34a',
      id: 'cal-other',
      isPrimary: false,
      isVisible: true,
      provider: 'google',
      summary: 'Other',
      timeZone: 'UTC',
    }),
  ],
  events: [parkedRow],
  pendingOps: [parkedUpdate('op-park', 10, parkedRow, 'Budget review (Google)')],
  taskLists: [
    new TaskListInfo({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      colorHex: '#ff0000',
      id: 'ek-list',
      isVisible: true,
      provider: 'apple',
      title: 'Reminders',
    }),
  ],
  tasks: [
    new TaskRecord({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      dueDate: localIsoDaysAgo(0),
      id: 'ek-water',
      listId: 'ek-list',
      provider: 'apple',
      status: 'needsAction',
      title: 'Water plants',
      updatedAt: 1,
    }),
  ],
};

/**
 * Logs every text each live region holds, in order, and marks the first
 * time a region is seen. Installed before the page's own scripts, so a
 * region's first entry is the commit that inserted it: empty when it was
 * mounted ahead of its content, as a screen reader needs it to be.
 */
const RECORD_LIVE_REGIONS = `(() => {
  const log = (window.__liveRegions = []);
  const seen = new WeakMap();
  const scan = () => {
    for (const region of document.querySelectorAll('[role="alert"], [role="status"]')) {
      const text = region.textContent ?? '';
      if (!seen.has(region) || seen.get(region) !== text) {
        log.push({ first: !seen.has(region), id: region.getAttribute('data-testid'), text });
        seen.set(region, text);
      }
    }
  };
  new MutationObserver(scan).observe(document, { characterData: true, childList: true, subtree: true });
})()`;

interface RegionEntry {
  readonly first: boolean;
  readonly id: string | null;
  readonly text: string;
}
const regionLog = async (cdp: App['cdp']): Promise<ReadonlyArray<RegionEntry>> =>
  JSON.parse(
    await cdp.eval<string>('JSON.stringify(window.__liveRegions ?? [])'),
  ) as Array<RegionEntry>;

interface Box {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}
/** The boxes of the given test ids, plus `column`: the box the stack is anchored in. */
const boxes = async (
  cdp: App['cdp'],
  ids: ReadonlyArray<string>,
): Promise<Record<string, Box | null>> =>
  JSON.parse(
    await cdp.eval<string>(`(() => {
      const box = (element) => {
        if (!element) return null;
        const { bottom, left, right, top } = element.getBoundingClientRect();
        return { bottom, left, right, top };
      };
      const byId = (id) => document.querySelector('[data-testid="' + id + '"]');
      return JSON.stringify({
        ...Object.fromEntries(${JSON.stringify(ids)}.map((id) => [id, box(byId(id))])),
        column: box(byId('notice-stack')?.parentElement),
      });
    })()`),
  ) as Record<string, Box | null>;

const overlaps = (a: Box, b: Box): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const within = (inner: Box, outer: Box): boolean =>
  inner.left >= outer.left &&
  inner.right <= outer.right &&
  inner.top >= outer.top &&
  inner.bottom <= outer.bottom;

/** Every box present, none overlapping another, each inside the stack's column. */
const expectStacked = (found: Record<string, Box | null>, ids: ReadonlyArray<string>) => {
  const column = found['column'];
  expect(column).toBeTruthy();
  const shown = ids.map((id) => {
    const box = found[id];
    expect(box, id).toBeTruthy();
    expect(within(box!, column!), `${id} inside the grid column`).toBe(true);
    return [id, box!] as const;
  });
  for (const [index, [id, box]] of shown.entries()) {
    for (const [otherId, other] of shown.slice(index + 1)) {
      expect(overlaps(box, other), `${id} overlaps ${otherId}`).toBe(false);
      // Listed top to bottom.
      expect(box.bottom <= other.top, `${id} above ${otherId}`).toBe(true);
    }
  }
};

const COMPLETE_WATER = 'button[aria-label="Complete task Water plants"]';
const FAILED = 'Couldn’t update the task — the change was not applied.';
const ANNOUNCED = 'Sync conflict: “Budget review (mine)” changed on Google while your edit waited.';

const setSelect = (selector: string, value: string) => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(element, ${JSON.stringify(value)});
  element.dispatchEvent(new Event('change', { bubbles: true }));
})()`;

describe('The notice stack', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(noticesSeed, {
      google: { fixture: noticesFixture },
      window: { height: 681, width: 1024 },
    });
  }, 60_000);
  afterEach(async (context) => {
    if (context.task.result?.state === 'fail') {
      await app.dump(context.task.name);
    }
  });
  afterAll(async () => {
    await app.stop();
  });

  it('mounts its live regions empty and tells a parked change once, politely', async () => {
    const { cdp } = app;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORD_LIVE_REGIONS });
    await cdp.send('Page.reload', {});
    await cdp.waitFor(`(${banner}).includes('Budget review (mine)')`);
    await expect
      .poll(async () => (await regionLog(cdp)).some((entry) => entry.text === ANNOUNCED), POLL)
      .toBe(true);

    const facts = JSON.parse(
      await cdp.eval<string>(`(() => {
        const role = (id) => document.querySelector('[data-testid="' + id + '"]')?.getAttribute('role');
        const banner = document.querySelector('[data-testid="conflict-banner"]');
        return JSON.stringify({
          alerts: role('notice-alerts'),
          bannerLabel: document.getElementById(banner?.getAttribute('aria-labelledby') ?? '')?.textContent,
          bannerTag: banner?.tagName,
          conflict: role('conflict-status'),
          dialogs: document.querySelectorAll('[role="alertdialog"]').length,
          status: role('notice-status'),
        });
      })()`),
    ) as Record<string, unknown>;
    expect(facts).toEqual({
      alerts: 'alert',
      bannerLabel: '“Budget review (mine)” changed on Google while your edit waited.',
      bannerTag: 'SECTION',
      conflict: 'status',
      dialogs: 0,
      status: 'status',
    });

    const log = await regionLog(cdp);
    for (const id of ['notice-alerts', 'notice-status', 'conflict-status']) {
      // Seen once as a new node, and empty then: its text came later.
      expect(log.filter((entry) => entry.id === id && entry.first)).toEqual([
        { first: true, id, text: '' },
      ]);
    }
    // Told once, however often the queue re-rendered since.
    expect(log.filter((entry) => entry.text === ANNOUNCED)).toHaveLength(1);
  });

  it('stacks a failed write above the banner, clear of the open editor and the sidebar', async () => {
    const { cdp } = app;
    await cdp.openEditor('[title^="Budget review (mine)"]');
    const complete = await cdp.locate(COMPLETE_WATER);
    await cdp.click(complete.x, complete.y);
    await cdp.waitFor(
      `document.querySelector('[data-testid="notice-alerts"] [data-testid="mutation-toast"]')?.textContent?.includes(${JSON.stringify(FAILED)})`,
    );
    // The failure reached the alert region that was mounted, empty, at load.
    const log = await regionLog(cdp);
    expect(
      log.some(
        (entry) => entry.id === 'notice-alerts' && !entry.first && entry.text.includes(FAILED),
      ),
    ).toBe(true);
    expect(log.filter((entry) => entry.id === 'notice-alerts' && entry.first)).toHaveLength(1);

    const found = await boxes(cdp, ['mutation-toast', 'conflict-banner', 'panel', 'sidebar']);
    expectStacked(found, ['mutation-toast', 'conflict-banner']);
    expect(
      await cdp.eval<string | null>(
        `document.querySelector('[data-testid="panel"]')?.getAttribute('data-panel-kind') ?? null`,
      ),
    ).toBe('editEvent');
    for (const id of ['mutation-toast', 'conflict-banner']) {
      expect(overlaps(found[id]!, found['panel']!), `${id} overlaps the panel`).toBe(false);
      expect(overlaps(found[id]!, found['sidebar']!), `${id} overlaps the sidebar`).toBe(false);
    }
    await cdp.clickButtonWithText('Cancel');
  });

  it('tells a change Google refused politely, in the same stack as the rest', async () => {
    const { cdp } = app;
    await cdp.openEditor('[title^="Move me"]');
    await cdp.eval(setSelect('select[aria-label="Calendar"]', 'acc-e2e:cal-other'));
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(
      `!!document.querySelector('[data-testid="notice-status"] [data-testid="dropped-toast"]')`,
      20_000,
    );
    const complete = await cdp.locate(COMPLETE_WATER);
    await cdp.click(complete.x, complete.y);
    await cdp.waitFor(`!!document.querySelector('[data-testid="mutation-toast"]')`);

    expectStacked(await boxes(cdp, ['mutation-toast', 'dropped-toast', 'conflict-banner']), [
      'mutation-toast',
      'dropped-toast',
      'conflict-banner',
    ]);
    const log = await regionLog(cdp);
    expect(
      log.some(
        (entry) =>
          entry.id === 'notice-status' &&
          !entry.first &&
          entry.text === 'Google rejected a change and it was discarded.',
      ),
    ).toBe(true);
    expect(log.filter((entry) => entry.id === 'notice-status' && entry.first)).toHaveLength(1);
  });
});
