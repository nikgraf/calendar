import { Account } from '@calendar/core';
import type { GoogleFixture } from '@calendar/sync/testing/googleFixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type App, launchApp, readEvents, readMirrorCopies } from './harness.ts';

// A calendar mirror against the fake Google API: the account is signed
// in, so the mirror's writes land and its copies come back through the
// pull — which the tokenless suite could never show.
/** Today at the given UTC hour: inside every mirror window, whatever the day. */
const todayAt = (hour: number): number => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour);
};
const SHARED = 'cal-shared';
const WORK = 'cal-work';
const iso = (ms: number) => new Date(ms).toISOString();

const googleFixture: GoogleFixture = {
  accounts: [{ email: 'e2e@nikgraf.com', id: 'acc-e2e', tasksEnabled: false }],
  calendars: [
    { accessRole: 'owner', id: WORK, primary: true, summary: 'Work' },
    { accessRole: 'owner', id: SHARED, summary: 'Shared' },
  ],
  events: {
    [WORK]: [
      {
        attendees: [{ email: 'boss@example.com', responseStatus: 'accepted' }],
        description: 'Agenda: the acquisition',
        end: { dateTime: iso(todayAt(11)) },
        id: 'evt-planning',
        location: 'Room 4',
        start: { dateTime: iso(todayAt(10)) },
        status: 'confirmed',
        summary: 'Planning',
      },
      {
        attendees: [{ email: 'e2e@nikgraf.com', responseStatus: 'declined', self: true }],
        end: { dateTime: iso(todayAt(15)) },
        id: 'evt-declined',
        start: { dateTime: iso(todayAt(14)) },
        status: 'confirmed',
        summary: 'Declined one',
      },
    ],
  },
};

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
  calendars: [],
  events: [],
};

const setInput = (selector: string, value: string) => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  const proto = window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, ${JSON.stringify(value)});
  element.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

const setSelect = (selector: string, value: string) => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  const proto = window.HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, ${JSON.stringify(value)});
  element.dispatchEvent(new Event('change', { bubbles: true }));
})()`;

describe('Calendar mirrors (fake Google)', () => {
  let app: App;
  let settings: App['cdp'];
  beforeAll(async () => {
    app = await launchApp(seed, { google: { fixture: googleFixture } });
    settings = await app.openSettings('mirrors');
  }, 60_000);
  afterAll(async () => {
    await app?.stop();
  });

  const copies = () => readMirrorCopies(app.userDataDir, 'acc-e2e', SHARED);

  it('creates a mirror from the editor and writes allow-listed copies', async () => {
    const cdp = settings;
    await cdp.waitFor(`document.body.textContent.includes('A mirror copies events')`);
    const add = await cdp.locate('[data-testid="mirror-add"]');
    await cdp.click(add.x, add.y);
    await cdp.eval(setInput('[data-testid="mirror-name"]', 'Family'));
    const source = await cdp.locate(
      '[data-testid="mirror-source-google-e2e-nikgraf-com-cal-work"]',
    );
    await cdp.click(source.x, source.y);
    await cdp.eval(
      setSelect('[data-testid="mirror-destination"]', 'google|e2e@nikgraf.com|cal-shared'),
    );
    // The preview says what others would see: the title and the place, nothing else.
    await cdp.waitFor(
      `document.querySelector('[data-testid="mirror-preview"]')?.textContent?.includes('1 event would be copied')`,
    );
    expect(
      await cdp.eval<string>(
        `document.querySelector('[data-testid="mirror-preview"]').textContent`,
      ),
    ).toContain('Planning · Room 4');
    const save = await cdp.locate('[data-testid="mirror-save"]');
    await cdp.click(save.x, save.y);
    await cdp.waitFor(`!!document.querySelector('[data-testid^="mirror-row-"]')`);

    await expect.poll(async () => (await copies()).length, { timeout: 20_000 }).toBe(1);
    const [copy] = await copies();
    expect(copy).toMatchObject({ location: 'Room 4', title: 'Planning' });
    expect(copy?.id.startsWith('slnvmr')).toBe(true);
    expect(copy?.description).toBeUndefined();
    expect(copy?.attendees).toBeUndefined();
    expect(copy?.reminders).toEqual({ overrides: [], useDefault: false });
    // Hidden from the calendar: the original is already drawn.
    expect((await readEvents(app.userDataDir)).some((event) => event.id === copy?.id)).toBe(false);
    await cdp.waitFor(
      `document.querySelector('[data-testid^="mirror-status-"]')?.textContent?.includes('Up to date')`,
    );
  });

  it('a preset change rewrites the copies, and deleting the mirror removes them', async () => {
    const cdp = settings;
    const row = await cdp.locate('[data-testid^="mirror-row-"]');
    const id = await cdp.eval<string>(
      `document.querySelector('[data-testid^="mirror-row-"]').dataset.testid.slice('mirror-row-'.length)`,
    );
    expect(row).toBeTruthy();
    await cdp.eval(
      `[...document.querySelectorAll('[data-testid="mirror-row-${id}"] button')].find(b => b.textContent === 'Edit').click()`,
    );
    const availability = await cdp.locate('[data-testid="mirror-preset-availability"]');
    await cdp.click(availability.x, availability.y);
    const save = await cdp.locate('[data-testid="mirror-save"]');
    await cdp.click(save.x, save.y);
    await expect
      .poll(async () => (await copies()).map((copy) => [copy.title, copy.location ?? null]), {
        timeout: 20_000,
      })
      .toEqual([['Busy', null]]);

    const remove = await cdp.locate(`[data-testid="mirror-delete-${id}"]`);
    await cdp.click(remove.x, remove.y);
    const confirm = await cdp.locate('[data-testid="mirror-delete-confirm"]');
    await cdp.click(confirm.x, confirm.y);
    await cdp.waitFor(`!document.querySelector('[data-testid^="mirror-row-"]')`);
    await expect.poll(async () => (await copies()).length, { timeout: 20_000 }).toBe(0);
  });
});
