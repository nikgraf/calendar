import {
  Account,
  APPLE_REMINDERS_ACCOUNT_ID,
  CalendarInfo,
  TaskListInfo,
  Temporal,
} from '@calendar/core';
import { titleFor } from '@calendar/app-state';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readEvents, readTasks } from './harness.ts';

const ZONE = 'Europe/Vienna';
const today = Temporal.Now.plainDateISO(ZONE);
const titleForDay = (day: Temporal.PlainDate) =>
  day.toLocaleString('en-US', { day: 'numeric', month: 'long', weekday: 'long', year: 'numeric' });
const seed = {
  accounts: [
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      email: 'e2e@example.com',
      id: 'account',
      provider: 'google',
      status: 'ok',
      tasksEnabled: true,
    }),
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      email: '',
      id: APPLE_REMINDERS_ACCOUNT_ID,
      provider: 'apple',
      status: 'ok',
      tasksEnabled: true,
    }),
  ],
  calendars: [
    new CalendarInfo({
      accessRole: 'owner',
      accountId: 'account',
      colorHex: '#3b82f6',
      id: 'calendar',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'Work',
      timeZone: ZONE,
    }),
  ],
  events: [],
  taskLists: [
    new TaskListInfo({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      id: 'reminders',
      isVisible: true,
      provider: 'apple',
      title: 'Reminders',
    }),
    new TaskListInfo({
      accountId: 'account',
      id: 'tasks',
      isVisible: true,
      provider: 'google',
      title: 'Tasks',
    }),
  ],
};

// Change dates only through the form: Assistant previews already navigate,
// which would hide a missing reveal after a successful create.
describe('the calendar after creating an item', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, {
      env: { TZ: ZONE },
      model: 'fixture',
      reminders: {
        fixture: { lists: [{ allowsModifications: true, id: 'reminders', title: 'Reminders' }] },
      },
    });
  }, 60_000);
  afterAll(async () => {
    await app?.stop();
  });
  afterEach(async (context) => {
    if (context.task.result?.state === 'fail') {
      await app?.dump(context.task.name);
    }
    if (await app.cdp.evaluate(($) => $.has('[data-testid="editor"]'))) {
      await app.cdp.discardEditor();
    }
  });
  beforeEach(async () => {
    await app.cdp.clickTestId('today');
    await app.cdp.clickTestId('view-day');
    await app.cdp.clickTestId('new-event');
    await app.cdp.showEditorView('form');
  });

  const setEvent = async (title: string, date: Temporal.PlainDate) => {
    await app.cdp.evaluate(
      ($, text: string, day: string) => {
        $.setValue('input[placeholder="Title"]', text);
        $.setValue('input[aria-label="Date"]', day);
      },
      title,
      date.toString(),
    );
  };
  const save = async () => {
    await app.cdp.clickButtonWithText('Save');
    await app.cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));
  };
  const expectDay = async (day: Temporal.PlainDate) => {
    await app.cdp.waitUntil(
      ($, title: string) => $.text('[data-testid="toolbar-title"]') === title,
      titleForDay(day),
    );
  };

  it('shows the saved date after a single event is created', async () => {
    const day = today.add({ days: 40 });
    await setEvent('Future appointment', day);
    await save();
    await expectDay(day);
    expect(
      (await readEvents(app.userDataDir)).some((event) => event.title === 'Future appointment'),
    ).toBe(true);
  });

  it('shows a new reminder on its due day', async () => {
    const day = today.add({ days: 45 });
    await app.cdp.clickTestId('mode-reminder');
    await app.cdp.evaluate(($, date: string) => {
      $.setValue('input[placeholder="Title"]', 'Future reminder');
      $.setValue('input[type="date"]', date);
    }, day.toString());
    await save();
    await expectDay(day);
    expect(
      (await readTasks(app.userDataDir)).find((task) => task.title === 'Future reminder')?.dueDate,
    ).toBe(day.toString());
  });

  it('shows a dated task and leaves the view alone for an undated task', async () => {
    const day = today.add({ days: 35 });
    await app.cdp.clickTestId('mode-task');
    await app.cdp.evaluate(($, date: string) => {
      $.setValue('input[placeholder="Title"]', 'Dated task');
      $.setValue('input[placeholder="YYYY-MM-DD"]', date);
    }, day.toString());
    await save();
    await expectDay(day);
    await app.cdp.clickTestId('new-event');
    await app.cdp.showEditorView('form');
    await app.cdp.clickTestId('mode-task');
    await app.cdp.evaluate(($) => $.setValue('input[placeholder="Title"]', 'Undated task'));
    await app.cdp.clickTestId('task-remove-due-date');
    await save();
    await expectDay(day);
    expect(
      (await readTasks(app.userDataDir)).find((task) => task.title === 'Undated task')?.dueDate,
    ).toBeUndefined();
  });

  it('keeps a repeating event in the displayed month', async () => {
    await app.cdp.clickTestId('view-month');
    const month = await app.cdp.evaluate(($) => $.text('[data-testid="toolbar-title"]'));
    await setEvent('Monthly view series', today.subtract({ days: 72 }));
    await app.cdp.evaluate(($) => $.setValue('select[aria-label="Repeat"]', 'weekly'));
    await save();
    expect(await app.cdp.evaluate(($) => $.text('[data-testid="toolbar-title"]'))).toBe(month);
  });

  it.each(['leading', 'trailing', 'repeat'])(
    'keeps the month when an occurrence is in its %s outer row',
    async (padding) => {
      const thisMonth = today.with({ day: 1 });
      let first = thisMonth;
      // Pick a nearby month with both outer rows, independent of today's weekday.
      while (first.dayOfWeek === 1 || first.with({ day: first.daysInMonth }).dayOfWeek === 7) {
        first = first.add({ months: 1 });
      }
      await app.cdp.clickTestId('view-month');
      const steps = thisMonth.until(first, { largestUnit: 'months' }).months;
      for (let index = 0; index < steps; index += 1) {
        await app.cdp.clickTestId('nav-next');
      }
      const title = titleFor('month', first, first, 'long');
      await app.cdp.waitUntil(
        ($, expected: string) => $.text('[data-testid="toolbar-title"]') === expected,
        title,
      );
      const day = padding === 'leading' ? first.subtract({ days: 1 }) : first.add({ months: 1 });
      expect(
        await app.cdp.evaluate(
          ($, date: string) => $.has(`[data-testid="month-grid"] [data-day="${date}"]`),
          day.toString(),
        ),
      ).toBe(true);
      await setEvent(
        `Outer row ${padding}`,
        padding === 'repeat' ? day.subtract({ years: 1 }) : day,
      );
      if (padding === 'repeat') {
        await app.cdp.evaluate(($) => $.setValue('select[aria-label="Repeat"]', 'yearly'));
      }
      await save();
      expect(await app.cdp.evaluate(($) => $.text('[data-testid="toolbar-title"]'))).toBe(title);
    },
  );

  it.each([false, true])(
    'keeps a rolled week in place when the saved occurrence is already visible (repeating: %s)',
    async (repeating) => {
      const first = today.subtract({ days: today.dayOfWeek - 1 }).add({ days: 2 });
      const day = first.add({ days: 5 });
      await app.cdp.clickTestId('view-week');
      await app.cdp.clickTestId(`mini-day-${first.toString()}`);
      const title = titleFor('week', first, first, 'long');
      await app.cdp.waitUntil(
        ($, expected: string) => $.text('[data-testid="toolbar-title"]') === expected,
        title,
      );
      await setEvent(
        repeating ? 'Visible repeating event' : 'Visible event',
        repeating ? day.subtract({ days: 70 }) : day,
      );
      if (repeating) {
        await app.cdp.evaluate(($) => $.setValue('select[aria-label="Repeat"]', 'weekly'));
      }
      await save();
      expect(await app.cdp.evaluate(($) => $.text('[data-testid="toolbar-title"]'))).toBe(title);
    },
  );

  it('picks the nearest occurrence before the current day instead of the series start', async () => {
    await setEvent('Weekly practice', today.subtract({ days: 72 }));
    await app.cdp.evaluate(($) => $.setValue('select[aria-label="Repeat"]', 'weekly'));
    await save();
    await expectDay(today.subtract({ days: 2 }));
  });

  it('picks the last occurrence when a new series already ended', async () => {
    const start = today.subtract({ days: 70 });
    await setEvent('Ended series', start);
    await app.cdp.evaluate(($) => {
      $.setValue('select[aria-label="Repeat"]', 'weekly');
      $.setValue('select[aria-label="Repeat ends"]', 'after');
    });
    await app.cdp.evaluate(($) => $.setValue('input[aria-label="Occurrence count"]', '3'));
    await save();
    await expectDay(start.add({ days: 14 }));
  });

  it.each([false, true])(
    'keeps a multi-day event already overlapping the view (repeating: %s)',
    async (repeating) => {
      await setEvent('Visible multi-day event', today.subtract({ days: 11 }));
      await app.cdp.evaluate(($, end: string) => {
        $.all<HTMLLabelElement>('label')
          .find((label) => label.textContent?.trim() === 'All-day')!
          .click();
        $.setValue('input[aria-label="End date"]', end);
      }, today.toString());
      if (repeating) {
        await app.cdp.evaluate(($) => $.setValue('select[aria-label="Repeat"]', 'weekly'));
        await app.cdp.evaluate(($) => $.setValue('input[aria-label="Repeat interval"]', '2'));
      }
      await save();
      await expectDay(today);
    },
  );

  it('leaves the calendar in place when an unsaved event is discarded', async () => {
    await setEvent('Discarded appointment', today.add({ days: 50 }));
    await app.cdp.discardEditor();
    await expectDay(today);
    expect(
      (await readEvents(app.userDataDir)).some((event) => event.title === 'Discarded appointment'),
    ).toBe(false);
  });
});
