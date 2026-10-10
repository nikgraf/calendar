import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  type App,
  launchApp,
  localIsoDaysAgo,
  readAccounts,
  readPendingOpsCount,
  readTaskLists,
  readTasks,
} from './harness.ts';

// The real thing: no seed, the helper talks to EventKit, and the machine's
// Reminders grant is already answered (CI seeds it — see e2e/ci/). Every
// row the app shows here came from the Swift bridge, so this covers the
// helper protocol, the write-through, the snapshot pass and the change
// push end to end. Skipped unless asked for: on a developer's Mac it
// would create reminders in their own database (they are deleted again,
// but the default e2e run must stay side-effect free).
const REAL = process.env['CALENDAR_E2E_REMINDERS'] === 'real';

const HELPER = join(
  import.meta.dirname,
  '..',
  'helper',
  '.build',
  'release',
  'solunivo-model-helper',
);

const isoToday = localIsoDaysAgo(0);

/** One stdio request to the helper, the way the app itself talks to it. */
const callHelper = (method: string, params: Record<string, unknown>): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const child = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`helper ${method}: no answer`));
    }, 15_000);
    lines.on('line', (line) => {
      const message = JSON.parse(line) as { error?: string; id?: number; result?: unknown };
      if (message.id !== 1) {
        return;
      }
      clearTimeout(timer);
      child.kill();
      if (message.error) {
        reject(new Error(`helper ${method}: ${message.error}`));
      } else {
        resolve(message.result);
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method, params })}\n`);
  });

describe.skipIf(!REAL)('Apple Reminders through the real helper', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(undefined, { reminders: 'real' });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });
  const EDITOR_OPEN = `!!document.querySelector('[data-testid="editor"]')`;
  afterEach(async (context) => {
    if (context.task.result?.state === 'fail') {
      await app.dump(context.task.name);
    }
    // A failure above must not strand its editor: `openChip` waits for it
    // to close.
    if (await app.cdp.eval<boolean>(EDITOR_OPEN)) {
      await app.cdp.clickButtonWithText('Cancel');
    }
  });

  const setTitle = async (title: string): Promise<void> => {
    await app.cdp.eval(`(() => {
      const input = document.querySelector('input[placeholder="Title"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(title)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  };

  /**
   * Opens a lane chip's editor by its body, past the leading checkbox. A
   * saved editor closes only once the write's reply is back, after the
   * database already shows it: measured while it is open, the chip sits in
   * the week the 360 px panel narrowed (at CI's 1024 px, a chip narrower
   * than the 40 px offset), and the click lands beside it — on a slot,
   * which opens "New event" and narrows the next try too.
   */
  const openChip = async (title: string) => {
    await app.cdp.waitFor<boolean>(`!(${EDITOR_OPEN})`);
    const chip = await app.cdp.locate(`[title=${JSON.stringify(title)}]`);
    await app.cdp.click(chip.x + 40, chip.y);
    await app.cdp.waitFor(`document.body.textContent.includes('Edit reminder')`);
  };

  it('connects without a prompt and mirrors the lists', async () => {
    const { cdp } = app;
    await cdp.waitFor(`document.body.textContent.includes('No accounts connected')`);
    await cdp.clickButtonWithText('Connect Apple Reminders');
    await expect
      .poll(async () => (await readAccounts(app.userDataDir)).map((account) => account.provider))
      .toContain('apple');
    // connectReminders forks a pass: the lists arrive without waiting for
    // the 90 s schedule.
    await expect
      .poll(async () => (await readTaskLists(app.userDataDir)).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    const sidebar = await cdp.waitFor<string>('document.body.textContent ?? ""');
    expect(sidebar).toContain('Apple Reminders');
  });

  it('creates, renames, and deletes a reminder through EventKit', async () => {
    const { cdp } = app;
    // Nothing is seeded, so any grid cell is free — but it must be today's
    // column: a date-only reminder on a past weekday rolls onto today as
    // overdue, and its tooltip then carries the due date after the title.
    const cell = await cdp.eval<{ x: number; y: number }>(`(() => {
      const scroller = document.querySelector('.overflow-y-scroll').getBoundingClientRect();
      const todayCell = document.querySelector('[data-testid="today-header"]').getBoundingClientRect();
      return { x: todayCell.left + todayCell.width / 2, y: scroller.top + 200 };
    })()`);
    await cdp.click(cell.x, cell.y);
    await cdp.waitFor(`document.body.textContent.includes('New event')`);
    // Only Apple lists exist, so Reminder is the one to-do kind on offer.
    await cdp.clickButtonWithText('Reminder');
    await cdp.waitFor(`document.body.textContent.includes('New reminder')`);
    await cdp.waitFor(`!!document.querySelector('select[aria-label="Task list"]')`);
    await setTitle('Solunivo ci reminder');
    await cdp.eval(
      `[...document.querySelectorAll('[role="radio"]')].find(r => r.textContent.trim() === 'High').click()`,
    );
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!!document.querySelector('[title="Solunivo ci reminder"]')`);
    // EventKit assigned the id (no temp id, no queued op): the row is the
    // bridge's own answer, mirrored.
    await expect
      .poll(async () => {
        const row = (await readTasks(app.userDataDir)).find(
          (task) => task.title === 'Solunivo ci reminder',
        );
        return (
          row && { id: row.id.startsWith('local-'), priority: row.priority, provider: row.provider }
        );
      })
      .toEqual({ id: false, priority: 'high', provider: 'apple' });
    expect(await readPendingOpsCount(app.userDataDir)).toBe(0);

    await openChip('Solunivo ci reminder');
    await setTitle('Solunivo ci reminder edited');
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!!document.querySelector('[title="Solunivo ci reminder edited"]')`);

    await openChip('Solunivo ci reminder edited');
    await cdp.clickButtonWithText('Delete');
    await cdp.confirmDelete();
    await cdp.waitFor(`!document.querySelector('[title="Solunivo ci reminder edited"]')`);
    await expect
      .poll(async () =>
        (await readTasks(app.userDataDir)).some((task) => task.title.startsWith('Solunivo ci')),
      )
      .toBe(false);
  });

  it('round-trips weekday and monthly-ordinal rules through EventKit', async () => {
    const { cdp } = app;
    const setSelect = (label: string, value: string) =>
      cdp.eval(`(() => {
        const select = document.querySelector('select[aria-label=${JSON.stringify(label)}]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(select, ${JSON.stringify(value)});
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
    const pressWeekday = async (day: string) => {
      const pressed = await cdp.eval<boolean>(
        `document.querySelector('[data-testid="repeat-weekday-${day}"]')?.getAttribute('aria-pressed') === 'true'`,
      );
      if (!pressed) {
        const button = await cdp.locate(`[data-testid="repeat-weekday-${day}"]`);
        await cdp.click(button.x, button.y);
      }
    };
    // Unique per attempt: a retry must not find (or delete) a reminder an
    // earlier attempt left behind.
    const title = `Solunivo ci weekends ${String(Date.now())}`;
    const row = async () => (await readTasks(app.userDataDir)).find((task) => task.title === title);

    const cell = await cdp.eval<{ x: number; y: number }>(`(() => {
      const scroller = document.querySelector('.overflow-y-scroll').getBoundingClientRect();
      const todayCell = document.querySelector('[data-testid="today-header"]').getBoundingClientRect();
      return { x: todayCell.left + todayCell.width / 2, y: scroller.top + 260 };
    })()`);
    await cdp.click(cell.x, cell.y);
    await cdp.waitFor(`document.body.textContent.includes('New event')`);
    await cdp.clickButtonWithText('Reminder');
    await cdp.waitFor(`!!document.querySelector('select[aria-label="Task list"]')`);
    await setTitle(title);
    await setSelect('Repeat', 'weekly');
    await pressWeekday('SA');
    await pressWeekday('SU');
    for (;;) {
      const extra = await cdp.eval<string | null>(
        `[...document.querySelectorAll('[data-testid^="repeat-weekday-"][aria-pressed="true"]')]
          .map(b => b.dataset.testid).find(id => !id.endsWith('-SA') && !id.endsWith('-SU')) ?? null`,
      );
      if (extra === null) {
        break;
      }
      const button = await cdp.locate(`[data-testid="${extra}"]`);
      await cdp.click(button.x, button.y);
    }
    await cdp.clickButtonWithText('Save');
    try {
      await expect.poll(row, { timeout: 15_000 }).toMatchObject({
        recurrence: { byDay: [{ weekday: 'SA' }, { weekday: 'SU' }], freq: 'weekly', interval: 1 },
      });
      expect((await row())?.recurrenceUnsupported).toBeUndefined();

      await openChip(title);
      await setSelect('Repeat', 'monthly');
      await setSelect('Monthly on', 'weekday');
      await setSelect('Ordinal', '2');
      await setSelect('Ordinal weekday', 'TU');
      await cdp.clickButtonWithText('Save');
      await expect.poll(row, { timeout: 15_000 }).toMatchObject({
        recurrence: { byDay: [{ ordinal: 2, weekday: 'TU' }], freq: 'monthly', interval: 1 },
      });
    } finally {
      // A failure above can leave an editor open; it would hide the chip's
      // real place from `openChip`.
      if (await cdp.eval<boolean>(EDITOR_OPEN)) {
        await cdp.clickButtonWithText('Cancel');
      }
      await openChip(title);
      await cdp.clickButtonWithText('Delete');
      await cdp.confirmDelete();
      await cdp.waitFor(`!document.querySelector(${JSON.stringify(`[title="${title}"]`)})`);
    }
  });

  it('shows a reminder created outside the app without waiting for the schedule', async () => {
    const { cdp } = app;
    const list = (await readTaskLists(app.userDataDir)).find((entry) => !entry.readOnly);
    expect(list, 'a writable Reminders list').toBeDefined();
    // Another process writes EventKit — as Reminders.app would — and the
    // EKEventStoreChanged push runs a delta pass within seconds.
    const created = (await callHelper('reminders.create', {
      listId: list!.id,
      reminder: { dueDate: isoToday, title: 'Solunivo ci push' },
    })) as { reminder: { id: string } };
    try {
      await cdp.waitFor(`!!document.querySelector('[title="Solunivo ci push"]')`, 15_000);
    } finally {
      await callHelper('reminders.delete', { id: created.reminder.id });
    }
    await cdp.waitFor(`!document.querySelector('[title="Solunivo ci push"]')`, 15_000);
  });
});
