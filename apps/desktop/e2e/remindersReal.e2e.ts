import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type App,
  launchApp,
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

const today = new Date();
const isoToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

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

  const setTitle = async (title: string): Promise<void> => {
    await app.cdp.eval(`(() => {
      const input = document.querySelector('input[placeholder="Title"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(title)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
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
    // Nothing is seeded, so any grid cell is free: click into the scroller.
    const cell = await cdp.eval<{ x: number; y: number }>(`(() => {
      const r = document.querySelector('.overflow-y-scroll').getBoundingClientRect();
      return { x: r.left + r.width * 0.5, y: r.top + 200 };
    })()`);
    await cdp.click(cell.x, cell.y);
    await cdp.waitFor(`document.body.textContent.includes('New event')`);
    await cdp.clickButtonWithText('Task');
    await cdp.waitFor(`document.body.textContent.includes('New task')`);
    // Only Apple lists exist, so this is the Reminders form.
    await cdp.waitFor(`!!document.querySelector('select[aria-label="Reminders list"]')`);
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

    const chip = await cdp.locate('[title="Solunivo ci reminder"]');
    await cdp.click(chip.x + 40, chip.y);
    await cdp.waitFor(`document.body.textContent.includes('Edit reminder')`);
    await setTitle('Solunivo ci reminder edited');
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!!document.querySelector('[title="Solunivo ci reminder edited"]')`);

    const renamed = await cdp.locate('[title="Solunivo ci reminder edited"]');
    await cdp.click(renamed.x + 40, renamed.y);
    await cdp.waitFor(`document.body.textContent.includes('Edit reminder')`);
    await cdp.clickButtonWithText('Delete');
    await cdp.waitFor(`!document.querySelector('[title="Solunivo ci reminder edited"]')`);
    await expect
      .poll(async () =>
        (await readTasks(app.userDataDir)).some((task) => task.title.startsWith('Solunivo ci')),
      )
      .toBe(false);
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
