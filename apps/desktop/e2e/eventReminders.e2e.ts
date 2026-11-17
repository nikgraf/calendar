import {
  Account,
  CalendarInfo,
  EventRecord,
  EventReminders,
  ReminderOverride,
} from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  type App,
  launchApp,
  localDayAt,
  readDeviceSetting,
  readEvents,
  readPendingOps,
} from './harness.ts';

// Event reminders edited in the desktop editor and stored with the
// pending update, plus the device-local notification switches. The
// harness runs with CALENDAR_NOTIFICATIONS=off, so the scheduler is
// silent; delivery itself is covered by the unit tests. Seeded relative
// to today (local hours) so the blocks are always in the week in view.
const HOUR_MS = 60 * 60 * 1000;
const todayAt = (hour: number): number => localDayAt(0, hour);

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

const USE_DEFAULT = 'input[aria-label="Use calendar default"]';

describe('event reminders', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed);
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  const openEvent = async (title: string) => {
    await app.cdp.openEditor(`[title^="${title}"]`);
    await app.cdp.waitUntil(($) => $.has('[data-testid="event-reminders"]'));
  };
  const selectMinutes = (index: number, minutes: number) =>
    app.cdp.evaluate(
      ($, row: number, value: string) => {
        const select = $.el<HTMLSelectElement>(`[data-testid="event-reminder-${String(row)}"]`)!;
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      },
      index,
      String(minutes),
    );

  it('turns "calendar default" into explicit notifications and queues them with the update', async () => {
    const { cdp } = app;
    await openEvent('Planning');
    await cdp.waitUntil(
      ($, useDefault: string) => $.el<HTMLInputElement>(useDefault)?.checked === true,
      USE_DEFAULT,
    );
    expect(await cdp.evaluate(($) => $.has('[data-testid="event-reminder-0"]'))).toBe(false);
    expect(
      await cdp.evaluate(
        ($, useDefault: string) => $.el(useDefault)!.parentElement!.textContent,
        USE_DEFAULT,
      ),
    ).toContain('10 minutes before');

    await cdp.evaluate(($, useDefault: string) => {
      $.el(useDefault)!.click();
    }, USE_DEFAULT);
    await cdp.waitUntil(
      ($, useDefault: string) => $.el<HTMLInputElement>(useDefault)?.checked === false,
      USE_DEFAULT,
    );
    await cdp.evaluate(($) => {
      $.el('[data-testid="event-reminder-add"]')!.click();
    });
    await cdp.waitUntil(($) => $.has('[data-testid="event-reminder-0"]'));
    await selectMinutes(0, 30);
    await cdp.waitUntil(($) => $.value('[data-testid="event-reminder-0"]') === '30');

    await cdp.clickButtonWithText('Save');
    await cdp.waitUntil(($) => !$.has('[data-testid="event-reminders"]'));
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
    await cdp.waitUntil(($) => $.value('[data-testid="event-reminder-0"]') === '30');
    expect(
      await cdp.evaluate(
        ($, useDefault: string) => $.el<HTMLInputElement>(useDefault)!.checked,
        USE_DEFAULT,
      ),
    ).toBe(false);
    await cdp.pressEscape();
    await cdp.waitUntil(($) => !$.has('[data-testid="event-reminders"]'));
  });

  it('shows email reminders read-only and leaves an unrelated edit without a reminders patch', async () => {
    const { cdp } = app;
    await openEvent('Review');
    // Canonical order puts the email reminder first; only the popup row (index 1) has a select.
    await cdp.waitUntil(($) => $.value('[data-testid="event-reminder-1"]') === '30');
    expect(
      await cdp.evaluate(($) => $.el('[data-testid="event-reminders"]')!.textContent),
    ).toContain('Email · 1 hour before');
    expect(await cdp.evaluate(($) => $.has('[data-testid="event-reminder-0"]'))).toBe(false);

    await cdp.evaluate(($) => $.setValue('input[placeholder="Title"]', 'Review (renamed)'));
    await cdp.clickButtonWithText('Save');
    await cdp.waitUntil(($) => !$.has('[data-testid="event-reminders"]'));
    await expect
      .poll(async () => {
        const ops = await readPendingOps(app.userDataDir);
        const op = ops.find((entry) => entry.kind === 'update' && entry.eventId === 'evt-custom');
        return op ? { flag: op.remindersChanged, title: op.payload?.title } : undefined;
      })
      .toEqual({ flag: undefined, title: 'Review (renamed)' });
  });

  it('stores the notification switches on this device only', async () => {
    const cdp = await app.openSettings('notifications');
    await cdp.waitUntil(() => document.body.textContent.includes('Event notifications'));
    expect(
      await cdp.evaluate(($) =>
        $.text('[data-testid="event-notifications-device-only"]').includes(
          'Stored only on this device',
        ),
      ),
    ).toBe(true);
    // On by default, nothing stored until the first change.
    expect(await readDeviceSetting(app.userDataDir, 'eventNotifications')).toBeNull();
    const clickInput = (label: string) =>
      cdp.evaluate(($, ariaLabel: string) => {
        $.el(`input[aria-label=${JSON.stringify(ariaLabel)}]`)?.click();
      }, label);
    const stored = () => readDeviceSetting(app.userDataDir, 'eventNotifications');
    await cdp.waitUntil(
      ($) =>
        $.el<HTMLInputElement>('input[aria-label="Notify me before events"]')?.checked === true,
    );
    await clickInput('Also for Apple Calendar events');
    // No "Remove When Over" in the row: the Mac has no such switch, so a
    // save there never makes up a value (one comes only from an import).
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ enabled: true, includeAppleCalendar: true });
    await clickInput('Notify me before events');
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ enabled: false, includeAppleCalendar: true });
    await cdp.waitUntil(
      ($) =>
        $.el<HTMLInputElement>('input[aria-label="Also for Apple Calendar events"]')?.disabled ===
        true,
    );
    await app.closeSettings();
  });
  it('stores the task notification switches and time on this device only', async () => {
    const cdp = await app.openSettings('notifications');
    await cdp.waitUntil(() => document.body.textContent.includes('Task notifications'));
    expect(
      await cdp.evaluate(($) =>
        $.text('[data-testid="task-notifications-device-only"]').includes(
          'Stored only on this device',
        ),
      ),
    ).toBe(true);
    // On by default, Reminders included, nothing stored until the first change.
    expect(await readDeviceSetting(app.userDataDir, 'taskNotifications')).toBeNull();
    const clickInput = (label: string) =>
      cdp.evaluate(($, ariaLabel: string) => {
        $.el(`input[aria-label=${JSON.stringify(ariaLabel)}]`)?.click();
      }, label);
    const stored = () => readDeviceSetting(app.userDataDir, 'taskNotifications');
    await cdp.waitUntil(
      ($) => $.el<HTMLInputElement>('input[aria-label="Notify me about tasks"]')?.checked === true,
    );
    await cdp.waitUntil(
      ($) =>
        $.el<HTMLInputElement>('input[aria-label="Also for Apple Reminders"]')?.checked === true,
    );
    await clickInput('Also for Apple Reminders');
    // No "Remove When Done" switches here: the Mac never removes a
    // notification, so a save stores no such value (one comes only from an import).
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ enabled: true, includeAppleReminders: false, time: '09:00' });
    await clickInput('Notify me about tasks');
    await expect
      .poll(stored, { timeout: 10_000 })
      .toEqual({ enabled: false, includeAppleReminders: false, time: '09:00' });
    // Disabled through its fieldset, which the `disabled` property does not show.
    await cdp.waitUntil(
      ($) => $.el('input[aria-label="Task notification time"]')?.matches(':disabled') === true,
    );
    await app.closeSettings();
  });
});
