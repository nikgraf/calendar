import { Account, Attendee, CalendarInfo, EventRecord } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchApp, readEvents, readPendingOpsCount, type App } from './harness.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HOUR_HEIGHT = 48;

/** Today at the given UTC hour. */
const todayAt = (hour: number, minute = 0): number => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute);
};

// The daily series starts three days back so several instances are visible
// in the current week no matter which weekday the suite runs on. All seeded
// hours sit mid-day UTC, so local (CI: UTC, dev: CET/CEST) and UTC dates
// agree and the Monday computed here matches the rendered week.
const dailyStart = todayAt(7) - 3 * DAY_MS;
const mondayAt7 = todayAt(7) - ((new Date().getUTCDay() + 6) % 7) * DAY_MS;
/** Start of the earliest daily-series instance inside the rendered week. */
const firstVisibleDaily = Math.max(dailyStart, mondayAt7);

const account = new Account({
  createdAt: 1,
  email: 'e2e@nikgraf.com',
  id: 'acc-e2e',
  status: 'ok',
});

const calendar = (id: string, summary: string, colorHex: string) =>
  new CalendarInfo({
    accessRole: 'owner',
    accountId: 'acc-e2e',
    colorHex,
    id,
    isPrimary: id === 'cal-work',
    isVisible: true,
    summary,
    timeZone: 'Europe/Vienna',
  });

const timedEvent = (
  id: string,
  calendarId: string,
  title: string,
  startUtc: number,
  endUtc: number,
  extra: Partial<EventRecord> = {},
) =>
  new EventRecord({
    accountId: 'acc-e2e',
    calendarId,
    endUtc,
    etag: '"e2e"',
    id,
    isAllDay: false,
    startTimeZone: 'Europe/Vienna',
    startUtc,
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    title,
    updatedAt: 1,
    ...extra,
  });

const seed = {
  accounts: [account],
  calendars: [
    calendar('cal-work', 'Work', '#3b82f6'),
    calendar('cal-personal', 'Personal', '#22c55e'),
  ],
  events: [
    timedEvent('evt-standup', 'cal-work', 'Standup meeting', todayAt(9), todayAt(10)),
    timedEvent('evt-gym', 'cal-personal', 'Gym session', todayAt(15), todayAt(16)),
    timedEvent('evt-daily', 'cal-work', 'Daily sync', dailyStart, dailyStart + 30 * 60 * 1000, {
      recurrence: ['RRULE:FREQ=DAILY;COUNT=14'],
      startTimeZone: 'UTC',
    }),
    timedEvent('evt-review', 'cal-work', 'Design review', todayAt(13), todayAt(14), {
      attendees: [
        new Attendee({
          email: 'organizer@example.com',
          isOrganizer: true,
          responseStatus: 'accepted',
        }),
        new Attendee({ email: 'e2e@nikgraf.com', responseStatus: 'needsAction' }),
      ],
      location: 'https://us02web.zoom.us/j/8881234567?pwd=e2e',
    }),
  ],
};

let app: App;

beforeAll(async () => {
  app = await launchApp(seed);
}, 60_000);

afterAll(async () => {
  await app?.stop();
});

const eventStart = async (title: string): Promise<number> => {
  const events = await readEvents(app.userDataDir);
  const match = events.find((event) => event.title === title);
  expect(match, `event "${title}" in db`).toBeDefined();
  return match!.startUtc;
};

const eventEnd = async (title: string): Promise<number> => {
  const events = await readEvents(app.userDataDir);
  return events.find((event) => event.title === title)!.endUtc;
};

/** Polls the app database until the predicate matches; returns the match. */
const waitForEvent = async (
  predicate: (event: EventRecord) => boolean,
): Promise<EventRecord | undefined> => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const match = (await readEvents(app.userDataDir)).find(predicate);
    if (match || Date.now() > deadline) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
};

/** Clicks the nth element matching the selector. */
const clickNth = async (selector: string, index: number): Promise<void> => {
  const point = await app.cdp.locate(selector, { index });
  await app.cdp.click(point.x, point.y);
};

/** Types into the editor's title field, React-style. */
const setEditorTitle = async (title: string): Promise<void> => {
  await app.cdp.eval(`(() => {
    const input = document.querySelector('input[placeholder="Title"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(title)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
};

describe('calendar desktop e2e', () => {
  it('renders the seeded week: sidebar, calendars, events', async () => {
    const { cdp } = app;
    await cdp.waitFor(`document.body.textContent.includes('e2e@nikgraf.com')`);
    await cdp.waitFor(`document.body.textContent.includes('Work')`);
    await cdp.waitFor(`!!document.querySelector('[title^="Standup meeting"]')`);
    await cdp.waitFor(`!!document.querySelector('[title^="Gym session"]')`);
    // The recurring master expands to multiple instances across the week.
    const dailyCount = await cdp.eval<number>(
      `document.querySelectorAll('[title^="Daily sync"]').length`,
    );
    expect(dailyCount).toBeGreaterThan(1);
  });

  it('switches views and navigates dates', async () => {
    const { cdp } = app;
    await cdp.clickButtonWithText('month');
    await cdp.waitFor(`document.body.textContent.includes('+') || true`);
    // Month view: weekday header row appears.
    await cdp.waitFor(`document.body.textContent.includes('Mon')`);

    await cdp.clickButtonWithText('day');
    await cdp.waitFor(`!!document.querySelector('[title^="Standup meeting"]')`);

    const titleBefore = await cdp.eval<string>(`document.querySelector('h1')?.textContent ?? ''`);
    await cdp.clickButtonWithText('›');
    const titleAfter = await cdp.waitFor<string>(
      `(document.querySelector('h1')?.textContent ?? '') !== ${JSON.stringify('')} && (document.querySelector('h1')?.textContent ?? '')`,
    );
    expect(titleAfter).not.toBe(titleBefore);
    await cdp.clickButtonWithText('Today');
    await cdp.clickButtonWithText('week');
    await cdp.waitFor(`!!document.querySelector('[title^="Standup meeting"]')`);
  });

  it('creates an event through the slot-click editor', async () => {
    const { cdp } = app;
    // A free slot: same column as Standup, 3 hours below its block.
    const block = await cdp.locate('[title^="Standup meeting"]');
    await cdp.click(block.x, block.y + 3 * HOUR_HEIGHT + 10);
    await cdp.waitFor(`document.body.textContent.includes('New event')`);
    await cdp.eval(`(() => {
      const input = document.querySelector('input[placeholder="Title"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Coffee chat');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!!document.querySelector('[title^="Coffee chat"]')`);
    expect(await eventStart('Coffee chat')).toBeGreaterThan(0);
  });

  it('edits an event title through the editor', async () => {
    const { cdp } = app;
    const block = await cdp.locate('[title^="Coffee chat"]');
    await cdp.click(block.x, block.y);
    await cdp.waitFor(`document.body.textContent.includes('Edit event')`);
    await cdp.eval(`(() => {
      const input = document.querySelector('input[placeholder="Title"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Coffee chat (moved)');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!!document.querySelector('[title^="Coffee chat (moved)"]')`);
  });

  it('drags an event to a new time and day', async () => {
    const { cdp } = app;
    const before = await eventStart('Standup meeting');
    const from = await cdp.locate('[title^="Standup meeting"]');
    const dayWidth = await cdp.eval<number>(
      `(document.querySelector('.relative.grid')?.getBoundingClientRect().width - 64) / 7`,
    );
    // Down 2 hours, right 1 day.
    await cdp.drag(from, {
      x: Math.round(from.x + dayWidth),
      y: from.y + 2 * HOUR_HEIGHT,
    });
    const expected = before + 2 * HOUR_MS + 24 * HOUR_MS;
    await cdp.waitFor(`true`);
    const deadline = Date.now() + 10_000;
    let moved = await eventStart('Standup meeting');
    while (moved !== expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      moved = await eventStart('Standup meeting');
    }
    expect(moved).toBe(expected);
  });

  it('drags the bottom handle to resize', async () => {
    const { cdp } = app;
    const before = await eventEnd('Gym session');
    const handle = await cdp.locate('[title^="Gym session"]', {
      atBottom: true,
    });
    await cdp.drag(handle, { x: handle.x, y: handle.y + HOUR_HEIGHT });
    const expected = before + HOUR_MS;
    const deadline = Date.now() + 10_000;
    let resized = await eventEnd('Gym session');
    while (resized !== expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      resized = await eventEnd('Gym session');
    }
    expect(resized).toBe(expected);
  });

  it('cancels a drag with Escape', async () => {
    const { cdp } = app;
    const before = await eventStart('Gym session');
    const from = await cdp.locate('[title^="Gym session"]');
    await cdp.mouse('mousePressed', from.x, from.y);
    for (let step = 1; step <= 5; step += 1) {
      await cdp.mouse('mouseMoved', from.x, from.y + step * 10);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await cdp.pressEscape();
    await cdp.mouse('mouseReleased', from.x, from.y + 50);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await eventStart('Gym session')).toBe(before);
    // The abandoned release must not fall through to a slot click.
    expect(await cdp.eval<boolean>(`document.body.textContent.includes('New event')`)).toBe(false);
  });

  it('drags a recurring instance into a single-instance override', async () => {
    const { cdp } = app;
    const from = await cdp.locate('[title^="Daily sync"]');
    await cdp.drag(from, { x: from.x, y: from.y + 2 * HOUR_HEIGHT });

    const expected = firstVisibleDaily + 2 * HOUR_MS;
    const override = await waitForEvent(
      (event) => event.recurringEventId === 'evt-daily' && event.startUtc === expected,
    );
    expect(override).toBeDefined();
    expect(override!.id).toContain('evt-daily_');
    // The master itself stays untouched.
    const events = await readEvents(app.userDataDir);
    expect(events.find((event) => event.id === 'evt-daily')!.startUtc).toBe(dailyStart);
  });

  it('edits a single occurrence through the editor scope selector', async () => {
    const { cdp } = app;
    // First matching block is the override created by the drag test.
    await clickNth('[title^="Daily sync"]', 0);
    await cdp.waitFor(`document.body.textContent.includes('This and following')`);
    await setEditorTitle('Daily sync (solo)');
    await cdp.clickButtonWithText('Save');

    const override = await waitForEvent((event) => event.title === 'Daily sync (solo)');
    expect(override).toBeDefined();
    expect(override!.recurringEventId).toBe('evt-daily');
    const events = await readEvents(app.userDataDir);
    expect(events.find((event) => event.id === 'evt-daily')!.title).toBe('Daily sync');
  });

  it('renames the whole series with the All events scope', async () => {
    const { cdp } = app;
    // Second matching block is a generated (non-override) instance.
    await clickNth('[title^="Daily sync"]', 1);
    await cdp.waitFor(`document.body.textContent.includes('All events')`);
    await cdp.clickButtonWithText('All events');
    await setEditorTitle('Daily standup');
    await cdp.clickButtonWithText('Save');

    const master = await waitForEvent(
      (event) => event.id === 'evt-daily' && event.title === 'Daily standup',
    );
    expect(master).toBeDefined();
    expect(master!.startUtc).toBe(dailyStart);
    // The detached override keeps its own title.
    await cdp.waitFor(`!!document.querySelector('[title^="Daily sync (solo)"]')`);
  });

  it('splits the series with this-and-following', async () => {
    const { cdp } = app;
    const block = await cdp.locate('[title^="Daily standup"]');
    await cdp.click(block.x, block.y);
    await cdp.waitFor(`document.body.textContent.includes('This and following')`);
    await cdp.clickButtonWithText('This and following');
    await setEditorTitle('Daily standup v2');
    await cdp.clickButtonWithText('Save');

    const newMaster = await waitForEvent(
      (event) => event.title === 'Daily standup v2' && event.recurrence !== undefined,
    );
    expect(newMaster).toBeDefined();
    // The split lands on the 2nd visible instance; earlier occurrences stay
    // with the truncated master.
    const splitStart = firstVisibleDaily + DAY_MS;
    const consumed = (splitStart - dailyStart) / DAY_MS;
    expect(newMaster!.recurrence).toEqual([`RRULE:FREQ=DAILY;COUNT=${14 - consumed}`]);
    expect(newMaster!.startUtc).toBe(splitStart);
    const events = await readEvents(app.userDataDir);
    const truncated = events.find((event) => event.id === 'evt-daily');
    expect(truncated!.recurrence?.[0]).toContain('UNTIL=');
  });

  it('deletes a single occurrence of a series', async () => {
    const { cdp } = app;
    const countBefore = await cdp.eval<number>(
      `document.querySelectorAll('[title^="Daily standup v2"]').length`,
    );
    const block = await cdp.locate('[title^="Daily standup v2"]');
    await cdp.click(block.x, block.y);
    await cdp.waitFor(`document.body.textContent.includes('This event')`);
    await cdp.clickButtonWithText('Delete');
    // One occurrence vanishes; the master survives.
    await cdp.waitFor(
      `document.querySelectorAll('[title^="Daily standup v2"]').length === ${countBefore - 1}`,
    );
    const events = await readEvents(app.userDataDir);
    expect(events.some((event) => event.title === 'Daily standup v2')).toBe(true);
  });

  it('toggles calendar visibility from the sidebar', async () => {
    const { cdp } = app;
    // Sidebar calendar rows are buttons labelled by summary.
    await cdp.eval(
      `[...document.querySelectorAll('aside button')].find(b => b.textContent?.includes('Personal'))?.click()`,
    );
    await cdp.waitFor(`!document.querySelector('[title^="Gym session"]')`);
    await cdp.eval(
      `[...document.querySelectorAll('aside button')].find(b => b.textContent?.includes('Personal'))?.click()`,
    );
    await cdp.waitFor(`!!document.querySelector('[title^="Gym session"]')`);
  });

  it('deletes an event through the editor', async () => {
    const { cdp } = app;
    const block = await cdp.locate('[title^="Coffee chat (moved)"]');
    await cdp.click(block.x, block.y);
    await cdp.waitFor(`document.body.textContent.includes('Edit event')`);
    await cdp.clickButtonWithText('Delete');
    await cdp.waitFor(`!document.querySelector('[title^="Coffee chat (moved)"]')`);
    const events = await readEvents(app.userDataDir);
    expect(events.some((event) => event.title === 'Coffee chat (moved)')).toBe(false);
  });

  it('creates a recurring event through the repeat picker', async () => {
    const { cdp } = app;
    // A free slot: Gym column (today), 3 hours above the block.
    const block = await cdp.locate('[title^="Gym session"]');
    await cdp.click(block.x, block.y - 3 * HOUR_HEIGHT);
    await cdp.waitFor(`document.body.textContent.includes('New event')`);
    await setEditorTitle('Yoga flow');
    // Pick "Daily", ending after 5 occurrences.
    await cdp.eval(`(() => {
      const setSelect = (label, value) => {
        const select = document.querySelector('select[aria-label="' + label + '"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setSelect('Repeat', 'daily');
      setSelect('Repeat ends', 'after');
    })()`);
    await cdp.eval(`(() => {
      const input = document.querySelector('input[aria-label="Occurrence count"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '5');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.clickButtonWithText('Save');

    const master = await waitForEvent(
      (event) => event.title === 'Yoga flow' && event.recurrence !== undefined,
    );
    expect(master).toBeDefined();
    expect(master!.recurrence).toEqual(['RRULE:FREQ=DAILY;COUNT=5']);
    // The optimistic master expands right away; late-week runs may only
    // have one in-window instance, so assert presence rather than count.
    await cdp.waitFor(`document.querySelectorAll('[title^="Yoga flow"]').length >= 1`);
  });

  it('accepts an invitation through the RSVP buttons', async () => {
    const { cdp } = app;
    const block = await cdp.locate('[title^="Design review"]');
    await cdp.click(block.x, block.y);
    await cdp.waitFor(`document.body.textContent.includes('Invitees')`);
    // The zoom link in the location surfaces as a Join button.
    await cdp.waitFor(
      `[...document.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Join meeting')`,
    );
    await cdp.clickButtonWithText('Accept');

    const updated = await waitForEvent(
      (event) =>
        event.id === 'evt-review' &&
        event.attendees?.find((attendee) => attendee.email === 'e2e@nikgraf.com')
          ?.responseStatus === 'accepted',
    );
    expect(updated).toBeDefined();
    // The organizer's entry stays untouched.
    expect(
      updated!.attendees!.find((attendee) => attendee.email === 'organizer@example.com')!
        .responseStatus,
    ).toBe('accepted');
    await cdp.clickButtonWithText('Cancel');
  });

  it('surfaces unsynced changes and discards a stuck op', async () => {
    const { cdp } = app;
    // Every mutation in this suite queued an op (no Google API available).
    const count = await readPendingOpsCount(app.userDataDir);
    expect(count).toBeGreaterThan(0);
    await cdp.waitFor(`document.body.textContent.includes('unsynced change')`);
    await cdp.eval(
      `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('unsynced change'))?.click()`,
    );
    // The discard mutation is fire-and-forget in the UI; re-click if a
    // transient failure swallowed the first attempt.
    const deadline = Date.now() + 12_000;
    let after = count;
    let lastClickAt = 0;
    while (after >= count && Date.now() < deadline) {
      if (Date.now() - lastClickAt > 3000) {
        await cdp.clickButtonWithText('Discard');
        lastClickAt = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      after = await readPendingOpsCount(app.userDataDir);
    }
    expect(after).toBeLessThan(count);
  });

  it('opens and closes the accounts modal', async () => {
    const { cdp } = app;
    await cdp.eval(
      `[...document.querySelectorAll('button')].find(b => b.title === 'Accounts')?.click()`,
    );
    await cdp.waitFor(`document.body.textContent.includes('Add Google Account')`);
    // Close by clicking the overlay backdrop.
    await cdp.click(20, 400);
    await cdp.waitFor(`!document.body.textContent.includes('Add Google Account')`);
  });
});
