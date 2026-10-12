import { Account, CalendarInfo, EventRecord, Temporal } from '@calendar/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readEvents } from './harness.ts';

// Slot proposals in the create thread: a phrase that asks for free time
// goes to the finder, the draft lands in the best free slot and the others
// are offered as chips in the panel and fainter candidate blocks on the
// grid; a chip or a candidate moves the draft; the next turn drops the
// proposals and Undo brings them back. The model is the deterministic
// fixture, so the finder phrase is in its grammar — `find … | Title`, the
// length, the day and the hours read from the words themselves — and the
// device zone is pinned (TZ) so the seeded morning is tomorrow's morning
// on every host.
const TZ = 'Europe/Vienna';
const tomorrow = Temporal.Now.plainDateISO(TZ).add({ days: 1 });
const at = (hour: number, minute: number): number =>
  tomorrow
    .toZonedDateTime({ plainTime: new Temporal.PlainTime(hour, minute), timeZone: TZ })
    .toInstant().epochMilliseconds;

const busy = (id: string, title: string, start: number, end: number) =>
  new EventRecord({
    accountId: 'acc-e2e',
    calendarId: 'cal-e2e',
    endUtc: end,
    etag: '"1"',
    id,
    isAllDay: false,
    startUtc: start,
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    title,
    updatedAt: 1,
  });

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
      timeZone: TZ,
    }),
  ],
  // Tomorrow's morning (08:00–12:00) in three gaps: 08:00–08:45,
  // 09:15–10:15 and 10:45–12:00.
  events: [
    busy('evt-standup', 'Standup', at(8, 45), at(9, 15)),
    busy('evt-sync', 'Sync', at(10, 15), at(10, 45)),
  ],
};

const INPUT = '[data-testid="quick-add-input"]';
const TITLE = 'input[placeholder="Title"]';
const START = 'input[aria-label="Start time"]';
const COMMAND_N = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }))`;
const blocks = `document.querySelectorAll('[data-testid="draft-block"]').length`;
const candidates = `document.querySelectorAll('[data-testid="slot-candidate"]').length`;
const blockAt = (start: string) =>
  `!!document.querySelector('[data-testid="draft-block"][data-draft-start="${start}"]')`;
const candidateAt = (start: string) =>
  `!!document.querySelector('[data-testid="slot-candidate"][data-draft-start="${start}"]')`;
const chips = `document.querySelectorAll('[data-testid^="draft-slot-"]').length`;
const pressedChip = `[...document.querySelectorAll('[data-testid^="draft-slot-"]')].findIndex((chip) => chip.getAttribute('aria-pressed') === 'true')`;
const lastSummary = `[...document.querySelectorAll('[data-testid="draft-turn-summary"]')].at(-1)?.textContent ?? ''`;
const titleIs = (title: string) =>
  `document.querySelector(${JSON.stringify(TITLE)})?.value === ${JSON.stringify(title)}`;

describe('Slot proposals in the create thread', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { env: { TZ }, model: 'fixture' });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });
  afterEach(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await app.cdp.eval<boolean>(`!!document.querySelector('[data-testid="editor"]')`))) {
        return;
      }
      await app.cdp.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  });

  it('puts the draft in the slot nearest the morning’s middle, offers the rest, moves on a chip or a candidate, drops them on a change and writes on Save', async () => {
    const { cdp } = app;
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(
      `document.querySelector('[data-testid="editor-title"]')?.textContent === 'New event'`,
    );
    await cdp.type(INPUT, 'find 30 min tomorrow morning | Focus');
    await cdp.clickTestId('quick-add-apply');
    // 09:15–10:15 holds a slot centred on 10:00; the other gaps rank after it.
    await cdp.waitFor(blockAt('09:45'));
    expect(await cdp.eval<number>(blocks)).toBe(1);
    expect(await cdp.eval<boolean>(titleIs('Focus'))).toBe(true);
    await cdp.waitFor(`${chips} === 3`);
    expect(await cdp.eval<number>(pressedChip)).toBe(0);
    expect(await cdp.eval<number>(candidates)).toBe(2);
    expect(await cdp.eval<boolean>(candidateAt('10:45'))).toBe(true);
    expect(await cdp.eval<boolean>(candidateAt('08:15'))).toBe(true);
    expect(await cdp.eval<string>(lastSummary)).toContain('3 free slots');

    // A chip moves the draft; the slot it left becomes a candidate.
    await cdp.clickTestId('draft-slot-1');
    await cdp.waitFor(blockAt('10:45'));
    await cdp.waitFor(`document.querySelector(${JSON.stringify(START)})?.value === '10:45'`);
    expect(await cdp.eval<number>(pressedChip)).toBe(1);
    await cdp.waitFor(candidateAt('09:45'));
    expect(await cdp.eval<number>(candidates)).toBe(2);

    // A candidate block moves it too.
    const early = await cdp.locate('[data-testid="slot-candidate"][data-draft-start="08:15"]');
    await cdp.click(early.x, early.y);
    await cdp.waitFor(blockAt('08:15'));
    expect(await cdp.eval<number>(pressedChip)).toBe(2);
    expect(await cdp.eval<number>(blocks)).toBe(1);

    // A change in words: the proposals were for the finder phrase, so they go; Undo brings them back.
    await cdp.type(INPUT, '| | 13:00-13:30');
    await cdp.clickTestId('quick-add-apply');
    await cdp.waitFor(blockAt('13:00'));
    await cdp.waitFor(`!document.querySelector('[data-testid="draft-slots"]')`);
    expect(await cdp.eval<number>(candidates)).toBe(0);
    await cdp.clickTestId('draft-undo');
    await cdp.waitFor(blockAt('08:15'));
    await cdp.waitFor(`${chips} === 3`);
    expect(await cdp.eval<number>(candidates)).toBe(2);

    // Save writes the draft where it sits; no candidate is left behind.
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`${blocks} === 0 && ${candidates} === 0`);
    await expect
      .poll(async () =>
        (await readEvents(app.userDataDir)).find((event) => event.title === 'Focus'),
      )
      .toMatchObject({
        calendarId: 'cal-e2e',
        endUtc: at(8, 45),
        isAllDay: false,
        startUtc: at(8, 15),
      });
  });

  it('a finder phrase as a later turn moves the draft into a slot, its title kept', async () => {
    const { cdp } = app;
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(
      `document.querySelector('[data-testid="editor-title"]')?.textContent === 'New event'`,
    );
    await cdp.type(INPUT, 'Review | +1 | 14:00-15:00');
    await cdp.clickTestId('quick-add-apply');
    await cdp.waitFor(blockAt('14:00'));
    expect(await cdp.eval<number>(chips)).toBe(0);

    // The draft's own length (an hour) is searched for: two morning gaps
    // hold it, 09:15–10:15 nearer the morning's middle than 10:45–11:45.
    await cdp.type(INPUT, 'find a slot tomorrow morning');
    await cdp.clickTestId('quick-add-apply');
    await cdp.waitFor(blockAt('09:15'));
    await cdp.waitFor(`document.querySelector(${JSON.stringify(START)})?.value === '09:15'`);
    expect(await cdp.eval<boolean>(titleIs('Review'))).toBe(true);
    await cdp.waitFor(`${chips} === 2`);
    expect(await cdp.eval<boolean>(candidateAt('10:45'))).toBe(true);
    expect(await cdp.eval<string>(lastSummary)).toBe('→ 09:15–10:15 · 2 free slots');
  });
});
