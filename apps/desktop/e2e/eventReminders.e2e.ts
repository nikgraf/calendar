import {
  Account,
  CalendarInfo,
  EventRecord,
  EventReminders,
  ReminderOverride,
} from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type App, launchApp, readDeviceSetting, readEvents, readPendingOps } from './harness.ts';

// Event reminders edited in the desktop editor and stored with the
// pending update, plus the device-local notification switches. The
// harness runs with CALENDAR_NOTIFICATIONS=off, so the scheduler is
// silent; delivery itself is covered by the unit tests. Seeded relative
// to today (UTC hours) so the blocks are always in the week in view.
const HOUR_MS = 60 * 60 * 1000;
const todayAt = (hour: number): number => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour);
};

const popup = (minutes: number) => new ReminderOverride({ method: 'popup', minutes });

const event = (fields: { hour: number; id: string; title: string } & Partial<EventRecord>) =>
  new EventRecord({
    accountId: 'acc-e2e',
    calendarId: 'cal-work',
    endUtc: todayAt(fields.hour) + HOUR_MS,
    etag: `"${fields.id}"`,
    isAllDay: false,
    startTimeZone: 'UTC',
    startUtc: todayAt(fields.hour),
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    updatedAt: 1,
    ...fields,
  });

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
      colorHex: '#4285f4',
      defaultReminders: [popup(10)],
      id: 'cal-work',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'Work',
      timeZone: 'UTC',
    }),
  ],
  events: [
    event({
      hour: 9,
      id: 'evt-default',
      reminders: new EventReminders({ overrides: [], useDefault: true }),
      title: 'Planning',
    }),
    event({
      hour: 14,
      id: 'evt-custom',
      reminders: new EventReminders({
        overrides: [new ReminderOverride({ method: 'email', minutes: 60 }), popup(30)],
        useDefault: false,
      }),
      title: 'Review',
    }),
  ],
};

const USE_DEFAULT = `document.querySelector('input[aria-label="Use calendar default"]')`;
const REMINDER = (index: number) =>
  `document.querySelector('[data-testid="event-reminder-${String(index)}"]')`;

describe('event reminders', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed);
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  const openEvent = async (title: string) => {
    const block = await app.cdp.locate(`[title^="${title}"]`);
    await app.cdp.click(block.x, block.y);
    await app.cdp.waitFor(`!!document.querySelector('[data-testid="event-reminders"]')`);
  };
  const selectMinutes = (index: number, minutes: number) =>
    app.cdp.eval(`(() => {
      const select = ${REMINDER(index)};
      select.value = ${JSON.stringify(String(minutes))};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);

  it('turns "calendar default" into explicit notifications and queues them with the update', async () => {
    const { cdp } = app;
    await openEvent('Planning');
    await cdp.waitFor(`${USE_DEFAULT}?.checked === true`);
    expect(await cdp.eval<boolean>(`!!${REMINDER(0)}`)).toBe(false);
    expect(await cdp.eval<string>(`${USE_DEFAULT}.parentElement.textContent`)).toContain(
      '10 minutes before',
    );

    await cdp.eval(`${USE_DEFAULT}.click()`);
    await cdp.waitFor(`${USE_DEFAULT}?.checked === false`);
    await cdp.eval(`document.querySelector('[data-testid="event-reminder-add"]').click()`);
    await cdp.waitFor(`!!${REMINDER(0)}`);
    await selectMinutes(0, 30);
    await cdp.waitFor(`${REMINDER(0)}.value === '30'`);

    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!document.querySelector('[data-testid="event-reminders"]')`);
    await expect
      .poll(async () => {
        const ops = await readPendingOps(app.userDataDir);
        const op = ops.find((entry) => entry.kind === 'update' && entry.eventId === 'evt-default');
        return op ? { flag: op.remindersChanged, reminders: op.payload?.reminders } : undefined;
      })
      .toEqual({
        flag: true,
        reminders: { overrides: [{ method: 'popup', minutes: 30 }], useDefault: false },
      });
    const stored = (await readEvents(app.userDataDir)).find((entry) => entry.id === 'evt-default');
    expect(stored?.reminders).toEqual(
      new EventReminders({ overrides: [popup(30)], useDefault: false }),
    );

    // Reopened: the row shows what was saved, and the default is off.
    await openEvent('Planning');
    await cdp.waitFor(`${REMINDER(0)}?.value === '30'`);
    expect(await cdp.eval<boolean>(`${USE_DEFAULT}.checked`)).toBe(false);
    await cdp.pressEscape();
    await cdp.waitFor(`!document.querySelector('[data-testid="event-reminders"]')`);
  });

  it('shows email reminders read-only and leaves an unrelated edit without a reminders patch', async () => {
    const { cdp } = app;
    await openEvent('Review');
    // Canonical order puts the email reminder first; only the popup row (index 1) has a select.
    await cdp.waitFor(`${REMINDER(1)}?.value === '30'`);
    expect(
      await cdp.eval<string>(
        `document.querySelector('[data-testid="event-reminders"]').textContent`,
      ),
    ).toContain('Email · 1 hour before');
    expect(await cdp.eval<boolean>(`!!${REMINDER(0)}`)).toBe(false);

    await cdp.eval(`(() => {
      const input = document.querySelector('input[placeholder="Title"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Review (renamed)');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!document.querySelector('[data-testid="event-reminders"]')`);
    await expect
      .poll(async () => {
        const ops = await readPendingOps(app.userDataDir);
        const op = ops.find((entry) => entry.kind === 'update' && entry.eventId === 'evt-custom');
        return op ? { flag: op.remindersChanged, title: op.payload?.title } : undefined;
      })
      .toEqual({ flag: undefined, title: 'Review (renamed)' });
  });

  it('stores the notification switches on this device only', async () => {
    const { cdp } = app;
    await cdp.eval(
      `[...document.querySelectorAll('button')].find(b => b.title === 'Accounts')?.click()`,
    );
    await cdp.waitFor(`document.body.textContent.includes('Event notifications')`);
    expect(
      await cdp.eval<boolean>(
        `document.querySelector('[data-testid="event-notifications-device-only"]')?.textContent?.includes('Stored only on this device') ?? false`,
      ),
    ).toBe(true);
    // On by default, nothing stored until the first change.
    expect(await readDeviceSetting(app.userDataDir, 'eventNotifications')).toBeNull();
    const clickInput = (label: string) =>
      cdp.eval(`document.querySelector('input[aria-label=${JSON.stringify(label)}]')?.click()`);
    const stored = () => readDeviceSetting(app.userDataDir, 'eventNotifications');
    await cdp.waitFor(
      `document.querySelector('input[aria-label="Notify me before events"]')?.checked === true`,
    );
    await clickInput('Also for Apple Calendar events');
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ enabled: true, includeAppleCalendar: true });
    await clickInput('Notify me before events');
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ enabled: false, includeAppleCalendar: true });
    await cdp.waitFor(
      `document.querySelector('input[aria-label="Also for Apple Calendar events"]')?.disabled === true`,
    );
    await cdp.pressEscape();
  });
});
