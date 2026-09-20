import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { APPLE_CALENDAR_ACCOUNT_ID } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type App, launchApp, readAccounts, readCalendars } from './harness.ts';

// The real thing: no seed, the helper talks to EventKit, and the machine's
// Calendars grant is already answered (CI seeds it — see e2e/ci/). Apple
// events are never stored, so every block asserted here was read live
// through the Swift bridge. Skipped unless asked for: on a developer's Mac
// it creates events in their default calendar (it deletes them again,
// but the default e2e run must stay side-effect free).
const REAL = process.env['CALENDAR_E2E_APPLE_CALENDAR'] === 'real';

const HELPER = join(
  import.meta.dirname,
  '..',
  'helper',
  '.build',
  'release',
  'solunivo-model-helper',
);

/** One stdio request to a fresh helper — another process, like Calendar.app. */
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

const at = (hour: number): number => {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
};

interface EventsResult {
  readonly events: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}
const todaysEvents = async () =>
  ((await callHelper('calendar.events', { endUtc: at(24), startUtc: at(0) })) as EventsResult)
    .events;

describe.skipIf(!REAL)('Apple Calendar through the real helper', () => {
  let app: App;
  const created: Array<string> = [];
  beforeAll(async () => {
    app = await launchApp(undefined, { appleCalendar: 'real' });
  }, 60_000);
  afterAll(async () => {
    for (const id of created) {
      await callHelper('calendar.delete', { id, span: 'futureEvents' }).catch(() => undefined);
    }
    await app.stop();
  });

  it('connects without a prompt and mirrors the calendars', async () => {
    const { cdp } = app;
    await cdp.waitFor(`document.body.textContent.includes('No accounts connected')`);
    await cdp.clickButtonWithText('Connect Apple Calendar');
    await expect
      .poll(async () => (await readAccounts(app.userDataDir)).map((account) => account.id))
      .toContain(APPLE_CALENDAR_ACCOUNT_ID);
    await expect
      .poll(async () => (await readCalendars(app.userDataDir)).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
  });

  it('shows an event created outside the app, edits and deletes it in EventKit', async () => {
    const { cdp } = app;
    const writable = (await readCalendars(app.userDataDir)).find(
      (calendar) => calendar.accessRole === 'owner',
    );
    expect(writable, 'a writable calendar').toBeDefined();
    const { event } = (await callHelper('calendar.create', {
      calendarId: writable!.id,
      event: {
        endUtc: at(11),
        isAllDay: false,
        startUtc: at(10),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        title: 'Solunivo ci event',
      },
    })) as { event: { id: string } };
    created.push(event.id);

    // EKEventStoreChanged reaches the app's helper and repaints the view.
    const block = await cdp.locate('[title^="Solunivo ci event"]');
    await cdp.click(block.x, block.y);
    await cdp.waitFor(`document.body.textContent.includes('Edit event')`);
    await cdp.eval(`(() => {
      const input = document.querySelector('input[placeholder="Title"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Solunivo ci event edited');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.clickButtonWithText('Save');
    await expect
      .poll(async () => (await todaysEvents()).find((entry) => entry.id === event.id)?.title)
      .toBe('Solunivo ci event edited');

    const renamed = await cdp.locate('[title^="Solunivo ci event edited"]');
    await cdp.click(renamed.x, renamed.y);
    await cdp.waitFor(`document.body.textContent.includes('Edit event')`);
    await cdp.clickButtonWithText('Delete');
    await expect
      .poll(async () => (await todaysEvents()).some((entry) => entry.id === event.id))
      .toBe(false);
    await cdp.waitFor(`!document.querySelector('[title^="Solunivo ci event"]')`, 15_000);
  });
});
