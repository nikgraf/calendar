import { Account, APPLE_REMINDERS_ACCOUNT_ID, TaskListInfo, TaskRecord } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type App,
  launchApp,
  localIsoDaysAgo,
  readEvents,
  readTasks,
  type RemindersFixture,
} from './harness.ts';

// Seeded straight into SQLite: the harness launches the app with
// CALENDAR_REMINDERS=off, so no EventKit sync can replace these rows and
// no TCC prompt can fire on a developer's Mac. This covers the UI half of
// the Reminders integration — chips, the provider-specific form, the
// sidebar section — without a real Reminders database.
const isoToday = localIsoDaysAgo(0);
const isoTomorrow = localIsoDaysAgo(-1);
const isoYesterday = localIsoDaysAgo(1);

const seed = {
  accounts: [
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      displayName: 'Apple Reminders',
      email: '',
      id: APPLE_REMINDERS_ACCOUNT_ID,
      provider: 'apple',
      status: 'ok',
      tasksEnabled: true,
    }),
  ],
  calendars: [],
  events: [],
  taskLists: [
    new TaskListInfo({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      colorHex: '#ff0000',
      id: 'ek-list-1',
      isVisible: true,
      provider: 'apple',
      title: 'Reminders',
    }),
    new TaskListInfo({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      colorHex: '#0000ff',
      id: 'ek-list-ro',
      isVisible: true,
      provider: 'apple',
      readOnly: true,
      title: 'Subscribed',
    }),
  ],
  tasks: [
    new TaskRecord({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      alarms: [-15],
      dueDate: isoToday,
      dueTime: '14:00',
      id: 'ek-rem-1',
      listId: 'ek-list-1',
      priority: 'high',
      provider: 'apple',
      recurrence: { freq: 'weekly', interval: 1 },
      status: 'needsAction',
      title: 'Call mom',
      updatedAt: 1,
    }),
    // Yesterday is always inside the rendered strip (two buffer days precede
    // the week), so a stale timed block on its own day would be in the DOM.
    new TaskRecord({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      dueDate: isoYesterday,
      dueTime: '09:00',
      id: 'ek-rem-overdue',
      listId: 'ek-list-1',
      provider: 'apple',
      status: 'needsAction',
      title: 'Overdue call',
      updatedAt: 1,
    }),
    // A by-day rule ("Weekends") the app cannot express: mirrored as
    // recurrenceUnsupported, it must still read as repeating.
    new TaskRecord({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      dueDate: isoToday,
      id: 'ek-rem-weekends',
      listId: 'ek-list-1',
      provider: 'apple',
      recurrenceUnsupported: true,
      status: 'needsAction',
      title: 'Theo reading',
      updatedAt: 1,
    }),
    new TaskRecord({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      dueDate: isoToday,
      id: 'ek-rem-allday',
      listId: 'ek-list-1',
      provider: 'apple',
      status: 'needsAction',
      title: 'Water plants',
      updatedAt: 1,
    }),
    new TaskRecord({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      dueDate: isoToday,
      id: 'ek-rem-milk',
      listId: 'ek-list-1',
      provider: 'apple',
      status: 'needsAction',
      title: 'Buy milk',
      updatedAt: 1,
    }),
    new TaskRecord({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      dueDate: isoToday,
      id: 'ek-rem-ro',
      listId: 'ek-list-ro',
      provider: 'apple',
      status: 'needsAction',
      title: 'Bin day',
      updatedAt: 1,
    }),
    new TaskRecord({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      dueDate: isoToday,
      dueTime: '11:00',
      id: 'ek-rem-ro-timed',
      listId: 'ek-list-ro',
      provider: 'apple',
      status: 'needsAction',
      title: 'Read-only timed',
      updatedAt: 1,
    }),
  ],
};

const remindersFixture: RemindersFixture = {
  lists: [
    {
      allowsModifications: true,
      colorHex: '#ff0000',
      id: 'ek-list-1',
      title: 'Reminders',
    },
    {
      allowsModifications: false,
      colorHex: '#0000ff',
      id: 'ek-list-ro',
      title: 'Subscribed',
    },
  ],
  reminders: [
    {
      alarms: [-15],
      completed: false,
      dueDate: isoToday,
      dueTime: '14:00',
      id: 'ek-rem-1',
      listId: 'ek-list-1',
      priority: 1,
      recurrence: { freq: 'weekly', interval: 1 },
      title: 'Call mom',
      updatedAt: 1,
    },
    {
      alarms: [],
      completed: false,
      dueDate: isoYesterday,
      dueTime: '09:00',
      id: 'ek-rem-overdue',
      listId: 'ek-list-1',
      priority: 0,
      title: 'Overdue call',
      updatedAt: 1,
    },
    {
      alarms: [],
      completed: false,
      dueDate: isoToday,
      id: 'ek-rem-weekends',
      listId: 'ek-list-1',
      priority: 0,
      recurrence: { unsupported: true },
      title: 'Theo reading',
      updatedAt: 1,
    },
    {
      alarms: [],
      completed: false,
      dueDate: isoToday,
      id: 'ek-rem-allday',
      listId: 'ek-list-1',
      priority: 0,
      title: 'Water plants',
      updatedAt: 1,
    },
    {
      alarms: [],
      completed: false,
      dueDate: isoToday,
      id: 'ek-rem-milk',
      listId: 'ek-list-1',
      priority: 0,
      title: 'Buy milk',
      updatedAt: 1,
    },
    {
      alarms: [],
      completed: false,
      dueDate: isoToday,
      id: 'ek-rem-ro',
      listId: 'ek-list-ro',
      priority: 0,
      title: 'Bin day',
      updatedAt: 1,
    },
    {
      alarms: [],
      completed: false,
      dueDate: isoToday,
      dueTime: '11:00',
      id: 'ek-rem-ro-timed',
      listId: 'ek-list-ro',
      priority: 0,
      title: 'Read-only timed',
      updatedAt: 1,
    },
  ],
};

describe('Apple Reminders UI', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { reminders: { fixture: remindersFixture } });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  it('renders timed reminders in the grid and date-only reminders in the all-day lane', async () => {
    const { cdp } = app;
    const chip = await cdp.locate('[data-testid="timed-task-ek-rem-1"]');
    expect(chip).toBeTruthy();
    const label = await cdp.waitFor<string>(
      `document.querySelector('[data-testid="timed-task-ek-rem-1"]')?.textContent ?? ''`,
    );
    expect(label).toContain('!!! Call mom');
    expect(label).not.toContain('14:00');
    // A weekly reminder carries the repeat marker; a one-off does not. So
    // does a rule the app cannot express (EventKit by-day, "Weekends").
    expect(label).toContain('\u21bb');
    expect(
      await cdp.eval<string>(
        `document.querySelector('[data-testid="all-day-task-ek-rem-weekends"]')?.textContent ?? ''`,
      ),
    ).toContain('\u21bb');
    expect(
      await cdp.eval<string>(
        `document.querySelector('[data-testid="timed-task-ek-rem-ro-timed"]')?.textContent ?? ''`,
      ),
    ).not.toContain('\u21bb');
    const tooltip = await cdp.eval<string>(
      `document.querySelector('[data-testid="timed-task-ek-rem-1"]')?.getAttribute('title') ?? ''`,
    );
    expect(tooltip).toMatch(/Call mom · 2:00 PM/i);
    expect(await cdp.eval(`!!document.querySelector('[title="Call mom"]')`)).toBe(false);
    expect(await cdp.locate('[title="Bin day"]')).toBeTruthy();
    const sidebar = await cdp.waitFor<string>('document.body.textContent ?? ""');
    expect(sidebar).toContain('Apple Reminders');
  });

  it('draws an overdue timed reminder as a marked all-day chip on today only', async () => {
    const { cdp } = app;
    const chip = await cdp.locate('[data-overdue][title^="Overdue call"]');
    expect(chip).toBeTruthy();
    // Overdue chips join the all-day lane in today's column; the past day
    // keeps no timed block for it.
    expect(
      await cdp.eval(`!!document.querySelector('[data-testid="timed-task-ek-rem-overdue"]')`),
    ).toBe(false);
    expect(
      await cdp.eval<number>(`document.querySelectorAll('[title^="Overdue call"]').length`),
    ).toBe(1);
    const facts = await cdp.eval<string>(`(() => {
      const chip = document.querySelector('[data-overdue][title^="Overdue call"]');
      const todayCell = document.querySelector('.bg-red-500')?.closest('.h-10');
      const chipRect = chip.getBoundingClientRect();
      const cellRect = todayCell.getBoundingClientRect();
      return JSON.stringify({
        inTodayColumn: chipRect.left >= cellRect.left - 1 && chipRect.right <= cellRect.right + 1,
        label: chip.textContent,
        tooltip: chip.getAttribute('title'),
      });
    })()`);
    const { inTodayColumn, label, tooltip } = JSON.parse(facts) as {
      inTodayColumn: boolean;
      label: string;
      tooltip: string;
    };
    expect(inTodayColumn).toBe(true);
    expect(label).toContain('\u26a0');
    expect(label).not.toContain('09:00');
    expect(tooltip).toMatch(/Overdue call · Overdue · due /);

    // Completing it from the chip clears the overdue state.
    const complete = await cdp.locate('button[aria-label="Complete task Overdue call"]');
    await cdp.click(complete.x, complete.y);
    await expect
      .poll(async () =>
        (await readTasks(app.userDataDir)).find((task) => task.id === 'ek-rem-overdue'),
      )
      .toMatchObject({ status: 'completed' });
    await cdp.waitFor(`!document.querySelector('[data-overdue][title^="Overdue call"]')`);
    expect(await cdp.eval(`document.body.textContent.includes('Edit reminder')`)).toBe(false);
  });

  it('completes a timed reminder from its checkbox without opening the editor', async () => {
    const { cdp } = app;
    const complete = await cdp.locate('button[aria-label="Complete reminder Call mom"]');
    await cdp.click(complete.x, complete.y);
    await expect
      .poll(async () => (await readTasks(app.userDataDir)).find((task) => task.id === 'ek-rem-1'))
      .toMatchObject({ status: 'completed' });
    expect(await cdp.eval(`document.body.textContent.includes('Edit reminder')`)).toBe(false);

    const reopen = await cdp.locate('button[aria-label="Reopen reminder Call mom"]');
    await cdp.click(reopen.x, reopen.y);
    await expect
      .poll(async () => (await readTasks(app.userDataDir)).find((task) => task.id === 'ek-rem-1'))
      .toMatchObject({ status: 'needsAction' });
  });

  it.each([
    { code: 'Enter', key: 'Enter', text: '\r', windowsVirtualKeyCode: 13 },
    { code: 'Space', key: ' ', text: ' ', windowsVirtualKeyCode: 32 },
  ])(
    'completes and reopens a timed reminder with $code on its checkbox',
    async ({ text, ...key }) => {
      const { cdp } = app;
      const eventsBefore = await readEvents(app.userDataDir);
      try {
        for (const { action, status } of [
          { action: 'Complete', status: 'completed' },
          { action: 'Reopen', status: 'needsAction' },
        ]) {
          const selector = `button[aria-label="${action} reminder Call mom"]`;
          await cdp.locate(selector);
          await cdp.eval(`document.querySelector(${JSON.stringify(selector)})?.focus()`);
          expect(
            await cdp.eval(`document.activeElement?.matches(${JSON.stringify(selector)})`),
          ).toBe(true);
          // Include the character generated by the physical key: Chromium needs
          // Enter's carriage return to perform the button's native activation.
          await cdp.send('Input.dispatchKeyEvent', { ...key, text, type: 'keyDown' });
          await cdp.send('Input.dispatchKeyEvent', { ...key, type: 'keyUp' });
          await expect
            .poll(async () =>
              (await readTasks(app.userDataDir)).find((task) => task.id === 'ek-rem-1'),
            )
            .toMatchObject({ status });
          expect(await cdp.eval(`document.body.textContent.includes('Edit reminder')`)).toBe(false);
          expect(await cdp.eval(`document.body.textContent.includes('New event')`)).toBe(false);
          expect(await cdp.eval(`!!document.querySelector('[data-testid="slot-selection"]')`)).toBe(
            false,
          );
        }
        expect(await readEvents(app.userDataDir)).toEqual(eventsBefore);
      } finally {
        // Keep the shared fixture ready for the editor and drag tests, even if an
        // assertion fails between completing and reopening the reminder.
        if (await cdp.eval(`document.body.textContent.includes('Edit reminder')`)) {
          await cdp.clickButtonWithText('Cancel');
        }
        if (
          (await readTasks(app.userDataDir)).find((task) => task.id === 'ek-rem-1')?.status ===
          'completed'
        ) {
          const reopen = await cdp.locate('button[aria-label="Reopen reminder Call mom"]');
          await cdp.click(reopen.x, reopen.y);
          await expect
            .poll(async () =>
              (await readTasks(app.userDataDir)).find((task) => task.id === 'ek-rem-1'),
            )
            .toMatchObject({ status: 'needsAction' });
        }
      }
    },
  );

  it('opens the Reminders form (time, priority, movable list) instead of the Google one', async () => {
    const { cdp } = app;
    const chip = await cdp.locate('[data-testid="timed-task-ek-rem-1"]');
    // Skip the leading checkbox, like the task-editor test does.
    await cdp.click(chip.x + 40, chip.y);
    try {
      await cdp.waitFor(`document.body.textContent.includes('Edit reminder')`);
      const facts = await cdp.waitFor<string>(`JSON.stringify({
        listEnabled: !document.querySelector('select[aria-label="Reminders list"]')?.disabled,
        priorityHigh: document.querySelector('[role="radio"][aria-checked="true"]')?.textContent,
        timeValue: document.querySelector('input[aria-label="Due time"]')?.value,
        timed: document.querySelector('input[aria-label="At a time"]')?.checked,
      })`);
      expect(JSON.parse(facts)).toEqual({
        listEnabled: true,
        priorityHigh: 'High',
        timed: true,
        timeValue: '14:00',
      });
    } finally {
      await cdp.clickButtonWithText('Cancel');
    }
  });

  it('cancels and persists timed-reminder drags without creating an event', async () => {
    const { cdp } = app;
    const original = await cdp.locate('[data-testid="timed-task-ek-rem-1"]');
    await cdp.mouse('mousePressed', original.x, original.y);
    await cdp.mouse('mouseMoved', original.x, original.y + 48);
    await cdp.pressEscape();
    await cdp.mouse('mouseReleased', original.x, original.y + 48);
    expect((await readTasks(app.userDataDir)).find((task) => task.id === 'ek-rem-1')).toMatchObject(
      {
        dueDate: isoToday,
        dueTime: '14:00',
      },
    );

    const beforeCancel = await cdp.locate('[data-testid="timed-task-ek-rem-1"]');
    const originalTop = await cdp.eval<number>(
      `document.querySelector('[data-testid="timed-task-ek-rem-1"]')?.getBoundingClientRect().y ?? 0`,
    );
    await cdp.eval(`
      window.__timedReminderPointerId = null;
      document.querySelector('[data-testid="timed-task-ek-rem-1"]')?.addEventListener(
        'pointerdown',
        event => { window.__timedReminderPointerId = event.pointerId; },
        { once: true },
      );
    `);
    await cdp.mouse('mousePressed', beforeCancel.x, beforeCancel.y);
    await cdp.mouse('mouseMoved', beforeCancel.x, beforeCancel.y + 48);
    await expect
      .poll(() =>
        cdp.eval<number>(
          `document.querySelector('[data-testid="timed-task-ek-rem-1"]')?.getBoundingClientRect().y ?? 0`,
        ),
      )
      .not.toBe(originalTop);
    await cdp.eval(`
      const target = document.querySelector('[data-testid="timed-task-ek-rem-1"]');
      target?.dispatchEvent(new PointerEvent('pointercancel', {
        bubbles: true,
        clientX: ${beforeCancel.x},
        clientY: ${beforeCancel.y + 48},
        pointerId: window.__timedReminderPointerId,
      }));
    `);
    await expect
      .poll(() =>
        cdp.eval<number>(
          `document.querySelector('[data-testid="timed-task-ek-rem-1"]')?.getBoundingClientRect().y ?? 0`,
        ),
      )
      .toBe(originalTop);
    await cdp.mouse('mouseReleased', beforeCancel.x, beforeCancel.y + 48);
    expect((await readTasks(app.userDataDir)).find((task) => task.id === 'ek-rem-1')).toMatchObject(
      {
        dueDate: isoToday,
        dueTime: '14:00',
      },
    );

    const dayWidth = await cdp.eval<number>(
      `document.querySelector('[data-testid="timed-task-ek-rem-1"]')?.parentElement?.getBoundingClientRect().width ?? 0`,
    );
    expect(dayWidth).toBeGreaterThan(0);
    const from = await cdp.locate('[data-testid="timed-task-ek-rem-1"]');
    await cdp.drag(from, { x: from.x + dayWidth, y: from.y + 48 });
    await expect
      .poll(async () => (await readTasks(app.userDataDir)).find((task) => task.id === 'ek-rem-1'))
      .toMatchObject({
        dueDate: isoTomorrow,
        dueTime: '15:00',
        recurrence: { freq: 'weekly', interval: 1 },
      });
    expect(await cdp.eval(`document.body.textContent.includes('New event')`)).toBe(false);
  });

  it('does not drag a timed reminder from a read-only list', async () => {
    const { cdp } = app;
    const from = await cdp.locate('[data-testid="timed-task-ek-rem-ro-timed"]');
    await cdp.drag(from, { x: from.x, y: from.y + 48 });
    expect(
      (await readTasks(app.userDataDir)).find((task) => task.id === 'ek-rem-ro-timed'),
    ).toMatchObject({ dueDate: isoToday, dueTime: '11:00' });
  });

  it('a reminder in a read-only list opens as a viewer: note shown, no Save, no Delete', async () => {
    const { cdp } = app;
    const chip = await cdp.locate('[title="Bin day"]');
    await cdp.click(chip.x + 40, chip.y);
    try {
      await cdp.waitFor(`!!document.querySelector('[data-testid="task-read-only"]')`);
      const facts = await cdp.waitFor<string>(`JSON.stringify({
        buttons: [...document.querySelectorAll('button')].map(b => b.textContent?.trim())
          .filter(t => t === 'Save' || t === 'Delete'),
        listDisabled: document.querySelector('select[aria-label="Reminders list"]')?.matches(':disabled'),
        note: document.querySelector('[data-testid="task-read-only"]')?.textContent,
      })`);
      expect(JSON.parse(facts)).toEqual({
        buttons: [],
        listDisabled: true,
        note: 'This list is read-only in Reminders.',
      });
    } finally {
      await cdp.clickButtonWithText('Cancel');
    }
  });
});

describe('Reminder chips drag between the all-day lane and the grid', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { reminders: { fixture: remindersFixture } });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  const HOUR_HEIGHT = 48;
  /** Viewport y of a wall-clock hour inside the scrolled grid. */
  const gridY = (hour: number) =>
    app.cdp.eval<number>(`(() => {
      const scroller = document.querySelector('.overflow-y-scroll');
      return scroller.getBoundingClientRect().top + ${hour * HOUR_HEIGHT} - scroller.scrollTop;
    })()`);
  const laneY = () =>
    app.cdp.eval<number>(`(() => {
      const rect = document.querySelector('[data-testid="all-day-lane"]').getBoundingClientRect();
      return rect.top + rect.height / 2;
    })()`);
  const dayWidth = () =>
    app.cdp.eval<number>(
      `document.querySelector('.relative.grid').getBoundingClientRect().width / document.querySelector('.relative.grid').children.length`,
    );
  const taskById = async (id: string) =>
    (await readTasks(app.userDataDir)).find((task) => task.id === id);
  // The first EventKit write after launch waits for the bridge to come up.
  const POLL = { timeout: 5000 };

  it('gives an all-day reminder a time when dropped into the grid', async () => {
    const { cdp } = app;
    const from = await cdp.locate('[data-testid="all-day-task-ek-rem-allday"]');
    await cdp.drag(from, { x: from.x, y: await gridY(10) });
    await expect
      .poll(() => taskById('ek-rem-allday'))
      .toMatchObject({
        dueDate: isoToday,
        dueTime: '10:00',
      });
    await cdp.locate('[data-testid="timed-task-ek-rem-allday"]');
    expect(await cdp.eval(`!!document.querySelector('[data-testid="task-drop-grid"]')`)).toBe(
      false,
    );
    expect(await cdp.eval(`document.body.textContent.includes('Edit reminder')`)).toBe(false);
  });

  it('clears the time of a timed reminder dropped into the lane on another day', async () => {
    const { cdp } = app;
    const from = await cdp.locate('[data-testid="timed-task-ek-rem-1"]');
    await cdp.drag(from, { x: from.x + (await dayWidth()), y: await laneY() });
    await expect
      .poll(() => taskById('ek-rem-1'))
      .toMatchObject({
        dueDate: isoTomorrow,
        recurrence: { freq: 'weekly', interval: 1 },
      });
    expect((await taskById('ek-rem-1'))?.dueTime).toBeUndefined();
    expect(await cdp.eval(`!!document.querySelector('[data-testid="task-drop-lane"]')`)).toBe(
      false,
    );
  });

  it('moves an all-day reminder to another day along the lane', async () => {
    const { cdp } = app;
    const from = await cdp.locate('[data-testid="all-day-task-ek-rem-milk"]');
    await cdp.drag(from, { x: from.x + (await dayWidth()), y: from.y });
    await expect.poll(() => taskById('ek-rem-milk'), POLL).toMatchObject({ dueDate: isoTomorrow });
    expect((await taskById('ek-rem-milk'))?.dueTime).toBeUndefined();
  });

  it('re-dates an overdue reminder to today at the dropped time', async () => {
    const { cdp } = app;
    const from = await cdp.locate('[data-overdue][title^="Overdue call"]');
    await cdp.drag(from, { x: from.x, y: await gridY(11) });
    await expect
      .poll(() => taskById('ek-rem-overdue'))
      .toMatchObject({
        dueDate: isoToday,
        dueTime: '11:00',
      });
    await cdp.waitFor(`!document.querySelector('[data-overdue][title^="Overdue call"]')`);
    await cdp.locate('[data-testid="timed-task-ek-rem-overdue"]');
  });

  it('does not drag a chip from a read-only list', async () => {
    const { cdp } = app;
    const from = await cdp.locate('[data-testid="all-day-task-ek-rem-ro"]');
    await cdp.drag(from, { x: from.x, y: await gridY(10) });
    expect(await taskById('ek-rem-ro')).toMatchObject({ dueDate: isoToday });
    expect((await taskById('ek-rem-ro'))?.dueTime).toBeUndefined();
    expect(await cdp.eval(`document.body.textContent.includes('Couldn')`)).toBe(false);
  });
});

describe('Apple Reminders mutation failures', () => {
  let app: App;
  beforeAll(async () => {
    // No bridge: the seeded row renders, while a drag write fails through the
    // same guarded mutation path used when EventKit becomes unavailable.
    app = await launchApp(seed);
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  it('keeps the stored due time when a drag cannot be saved', async () => {
    const from = await app.cdp.locate('[data-testid="timed-task-ek-rem-1"]');
    await app.cdp.drag(from, { x: from.x, y: from.y + 48 });
    await app.cdp.waitFor(`document.body.textContent.includes('reschedule the reminder')`);
    expect((await readTasks(app.userDataDir)).find((task) => task.id === 'ek-rem-1')).toMatchObject(
      {
        dueDate: isoToday,
        dueTime: '14:00',
      },
    );
  });
});
