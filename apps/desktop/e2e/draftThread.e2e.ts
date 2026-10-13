import { Account, CalendarInfo } from '@calendar/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readEvents } from './harness.ts';

// The draft thread: a phrase makes drafts the grid draws hatched, every
// later phrase changes them, Undo takes a turn back, Save writes. The model
// is the deterministic fixture, so phrases are in its grammar —
// `Title | +N | HH:MM-HH:MM | Location`, empty parts in a change meaning
// "unchanged" — and nothing here depends on the date or on Apple
// Intelligence.
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

const INPUT = '[data-testid="quick-add-input"]';
const TITLE = 'input[placeholder="Title"]';
const START = 'input[aria-label="Start time"]';
// CDP key events don't carry macOS meta reliably: dispatch ⌘N to the app's own window listener.
const COMMAND_N = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }))`;
const blocks = `document.querySelectorAll('[data-testid="draft-block"]').length`;
const blockAt = (start: string) =>
  `!!document.querySelector('[data-testid="draft-block"][data-draft-start="${start}"]')`;
const turns = `document.querySelectorAll('[data-testid="draft-turn"]').length`;
// The list runs newest first: the first summary is the last turn's.
const newestSummary = `document.querySelector('[data-testid="draft-turn-summary"]')?.textContent ?? ''`;
const position = `(document.querySelector('[data-testid="draft-position"]')?.textContent ?? '')`;
const titleIs = (title: string) =>
  `document.querySelector(${JSON.stringify(TITLE)})?.value === ${JSON.stringify(title)}`;

/** A paste as the OS would deliver it, on the window: the text as text/plain. */
const paste = (text: string) => `(() => {
  const data = new DataTransfer();
  data.setData('text/plain', ${JSON.stringify(text)});
  window.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
})()`;

describe('The draft thread', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { model: 'fixture' });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });
  afterEach(async () => {
    // A failure above must not strand an editor for the next test.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await app.cdp.eval<boolean>(`!!document.querySelector('[data-testid="editor"]')`))) {
        return;
      }
      await app.cdp.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  });

  it('draws a phrase as a draft, moves it on a second phrase, takes it back on Undo, and writes it on Save', async () => {
    const { cdp } = app;
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(
      `document.querySelector('[data-testid="editor-title"]')?.textContent === 'New event'`,
    );
    await cdp.type(INPUT, 'Dinner | +2 | 19:00-20:00');
    await cdp.clickTestId('quick-add-apply');
    // The draft is on the grid, hatched and outlined, and the form holds it.
    await cdp.waitFor(blockAt('19:00'));
    expect(await cdp.eval<number>(blocks)).toBe(1);
    expect(await cdp.eval<boolean>(titleIs('Dinner'))).toBe(true);
    expect(await cdp.eval<number>(turns)).toBe(1);
    // The field is free for the next phrase.
    expect(await cdp.eval<string>(`document.querySelector(${JSON.stringify(INPUT)}).value`)).toBe(
      '',
    );

    // A change: the same field, the block moves, the form follows, a turn is listed.
    await cdp.type(INPUT, '| | 20:00-21:00');
    await cdp.clickTestId('quick-add-apply');
    await cdp.waitFor(blockAt('20:00'));
    expect(await cdp.eval<number>(blocks)).toBe(1);
    await cdp.waitFor(`document.querySelector(${JSON.stringify(START)})?.value === '20:00'`);
    expect(await cdp.eval<number>(turns)).toBe(2);
    // The newest turn on top, with the Undo.
    expect(await cdp.eval<string>(newestSummary)).toContain('20:00–21:00');
    expect(
      await cdp.eval<boolean>(
        `!!document.querySelector('[data-testid="draft-turn"] [data-testid="draft-undo"]')`,
      ),
    ).toBe(true);

    // Undo: the turn is gone, the block and the form are back.
    await cdp.clickTestId('draft-undo');
    await cdp.waitFor(blockAt('19:00'));
    await cdp.waitFor(`document.querySelector(${JSON.stringify(START)})?.value === '19:00'`);
    expect(await cdp.eval<number>(turns)).toBe(1);

    // Save writes the draft; no draft is left on the grid, the event is.
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`${blocks} === 0`);
    await expect
      .poll(async () =>
        (await readEvents(app.userDataDir)).find((event) => event.title === 'Dinner'),
      )
      .toMatchObject({ calendarId: 'cal-e2e', isAllDay: false });
    await cdp.locate('[title^="Dinner ·"]');
  });

  it('lists the turns newest first, three until "+1 earlier query" opens the rest, and flashes the field a turn changed', async () => {
    const { cdp } = app;
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(
      `document.querySelector('[data-testid="editor-title"]')?.textContent === 'New event'`,
    );
    await cdp.type(INPUT, 'Gym | +3 | 07:00-08:00');
    await cdp.clickTestId('quick-add-apply');
    await cdp.waitFor(blockAt('07:00'));
    for (const [start, end] of [
      ['08:00', '09:00'],
      ['09:00', '10:00'],
      ['10:00', '11:00'],
    ] as const) {
      await cdp.type(INPUT, `| | ${start}-${end}`);
      await cdp.clickTestId('quick-add-apply');
      await cdp.waitFor(blockAt(start));
    }
    // The start time the last turn moved tints and fades back.
    await cdp.waitFor(
      `document.querySelector(${JSON.stringify(START)})?.getAnimations().length === 1`,
    );
    expect(await cdp.eval<number>(turns)).toBe(3);
    expect(await cdp.eval<string>(newestSummary)).toContain('10:00–11:00');
    const more = `document.querySelector('[data-testid="draft-turns-more"]')?.textContent ?? ''`;
    expect(await cdp.eval<string>(more)).toBe('+1 earlier query');
    await cdp.clickTestId('draft-turns-more');
    await cdp.waitFor(`${turns} === 4`);
    expect(
      await cdp.eval<string>(
        `[...document.querySelectorAll('[data-testid="draft-turn-summary"]')].at(-1).textContent`,
      ),
    ).toContain('Gym');
    await cdp.clickTestId('draft-turns-less');
    await cdp.waitFor(`${turns} === 3`);
  });

  it('opens a pasted mail as one thread of drafts: the pager and the blocks switch the form, Remove drops one, Add all writes the rest', async () => {
    const { cdp } = app;
    await cdp.eval(
      paste(
        [
          'Standup | +0 | 09:00-09:30 | Room 4',
          'Planning | +1 | 14:00-15:00',
          'Review | +1 | 16:00-17:00',
        ].join('\n'),
      ),
    );
    await cdp.waitFor(`${position} === '1 of 3'`);
    await cdp.waitFor(`${blocks} === 3`);
    expect(await cdp.eval<boolean>(titleIs('Standup'))).toBe(true);

    // A click on another draft's block focuses it.
    const planning = await cdp.locate('[data-testid="draft-block"][data-draft-start="14:00"]');
    await cdp.click(planning.x, planning.y);
    await cdp.waitFor(`${position} === '2 of 3'`);
    await cdp.waitFor(titleIs('Planning'));
    expect(
      await cdp.eval<boolean>(
        `!!document.querySelector('[data-testid="draft-block"][data-draft-start="14:00"][data-focused]')`,
      ),
    ).toBe(true);

    // The pager: next, then Remove drops the third.
    await cdp.clickTestId('draft-next');
    await cdp.waitFor(`${position} === '3 of 3'`);
    await cdp.waitFor(titleIs('Review'));
    await cdp.clickTestId('draft-remove');
    await cdp.waitFor(`${position} === '2 of 2'`);
    await cdp.waitFor(`${blocks} === 2`);
    await cdp.waitFor(titleIs('Planning'));

    // Add all: both written, the editor closed, no draft left.
    await cdp.clickTestId('draft-add-all');
    await cdp.waitFor(`!document.querySelector('[data-testid="editor"]')`);
    await cdp.waitFor(`${blocks} === 0`);
    await expect
      .poll(async () => {
        const events = await readEvents(app.userDataDir);
        return ['Standup', 'Planning', 'Review'].map((title) =>
          events.some((event) => event.title === title),
        );
      })
      .toEqual([true, true, false]);
    expect(
      (await readEvents(app.userDataDir)).find((event) => event.title === 'Standup'),
    ).toMatchObject({ location: 'Room 4' });
  });
});
