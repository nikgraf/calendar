import { Account, CalendarInfo, EventRecord } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchApp, readEvents, type App } from './harness.ts';

const HOUR_MS = 60 * 60 * 1000;
const HOUR_HEIGHT = 48;

/** Today at the given UTC hour. */
const todayAt = (hour: number, minute = 0): number => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute);
};

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
    timedEvent('evt-daily', 'cal-work', 'Daily sync', todayAt(7), todayAt(7, 30), {
      recurrence: ['RRULE:FREQ=DAILY;COUNT=14'],
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
  });

  it('refuses to drag recurring instances and shows the notice', async () => {
    const { cdp } = app;
    const before = await eventStart('Daily sync');
    const from = await cdp.locate('[title^="Daily sync"]');
    await cdp.drag(from, { x: from.x, y: from.y + 2 * HOUR_HEIGHT });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await eventStart('Daily sync')).toBe(before);

    await cdp.click(from.x, from.y);
    await cdp.waitFor(`document.body.textContent.includes('Editing recurring events')`);
    await cdp.clickButtonWithText('Cancel');
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
