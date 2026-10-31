import { describe, expect, it } from 'vite-plus/test';
import { APPLE_REMINDERS_ACCOUNT_ID, TaskListInfo, TaskRecord } from '../types.ts';
import { DEFAULT_TASK_NOTIFICATION_SETTINGS, type TaskNotificationSettings } from './settings.ts';
import { planTaskReminders } from './taskReminders.ts';

const utc = (iso: string): number => Date.parse(iso);

const inbox = new TaskListInfo({
  accountId: 'acc',
  id: 'inbox',
  isVisible: true,
  provider: 'google',
  title: 'Inbox',
});
const errands = new TaskListInfo({
  accountId: APPLE_REMINDERS_ACCOUNT_ID,
  id: 'ek-errands',
  isVisible: true,
  provider: 'apple',
  title: 'Errands',
});

const task = (overrides: Partial<TaskRecord> = {}): TaskRecord =>
  new TaskRecord({
    accountId: 'acc',
    dueDate: '2026-03-04',
    id: 't1',
    listId: 'inbox',
    provider: 'google',
    status: 'needsAction',
    title: 'Pay rent',
    updatedAt: 0,
    ...overrides,
  });

const reminder = (overrides: Partial<TaskRecord> = {}): TaskRecord =>
  task({
    accountId: APPLE_REMINDERS_ACCOUNT_ID,
    id: 'rem-1',
    listId: 'ek-errands',
    provider: 'apple',
    title: 'Call the bank',
    ...overrides,
  });

// Vienna is UTC+1 in March.
const window = {
  fromDate: '2026-03-04',
  lists: [inbox],
  timeZone: 'Europe/Vienna',
  untilDate: '2026-03-11',
};

const settings = (overrides: Partial<TaskNotificationSettings> = {}): TaskNotificationSettings => ({
  ...DEFAULT_TASK_NOTIFICATION_SETTINGS,
  ...overrides,
});

describe('planTaskReminders', () => {
  it('plans a day-only task at the set time on its due day, on the device clock', () => {
    const plans = planTaskReminders([task()], settings(), window);
    expect(plans).toEqual([
      {
        body: 'Due today',
        expiresAt: utc('2026-03-04T23:00:00Z'),
        fireAt: utc('2026-03-04T08:00:00Z'),
        key: 'task:acc/t1:2026-03-04',
        since: 0,
        target: {
          accountId: 'acc',
          dueDate: '2026-03-04',
          kind: 'task',
          listId: 'inbox',
          taskId: 't1',
        },
        title: 'Pay rent',
      },
    ]);
    expect(planTaskReminders([task()], settings({ time: '17:30' }), window)[0]!.fireAt).toBe(
      utc('2026-03-04T16:30:00Z'),
    );
    // An unreadable time falls back to 09:00, like a birthday reminder's.
    expect(planTaskReminders([task()], settings({ time: '25:99' }), window)[0]!.fireAt).toBe(
      utc('2026-03-04T08:00:00Z'),
    );
  });

  it('plans a reminder with a time of its own at that time, and at its instant when it has one', () => {
    const lists = [inbox, errands];
    const timed = planTaskReminders([reminder({ dueTime: '14:00' })], settings(), {
      ...window,
      lists,
    });
    expect(timed.map((plan) => [plan.fireAt, plan.body])).toEqual([
      [utc('2026-03-04T13:00:00Z'), 'Due today · 2:00 PM · Errands'],
    ]);
    const zoned = planTaskReminders(
      [reminder({ dueTime: '14:00', dueUtc: utc('2026-03-04T12:00:00Z') })],
      settings(),
      { ...window, lists },
    );
    expect(zoned.map((plan) => [plan.fireAt, plan.body])).toEqual([
      [utc('2026-03-04T12:00:00Z'), 'Due today · 1:00 PM · Errands'],
    ]);
  });

  it('includes Apple Reminders by default and leaves them out when switched off', () => {
    const lists = [inbox, errands];
    expect(
      planTaskReminders([task(), reminder()], settings(), { ...window, lists }).map(
        (plan) => plan.key,
      ),
    ).toEqual(['task:acc/t1:2026-03-04', 'task:apple-reminders/rem-1:2026-03-04']);
    expect(
      planTaskReminders([task(), reminder()], settings({ includeAppleReminders: false }), {
        ...window,
        lists,
      }).map((plan) => plan.key),
    ).toEqual(['task:acc/t1:2026-03-04']);
  });

  it("a reminder with an instant of its own lives on that instant's day here, whatever day its row says", () => {
    // Read in UTC, the row says the 3rd; in Vienna the instant falls on the 4th.
    const late = reminder({
      dueDate: '2026-03-03',
      dueTime: '23:30',
      dueUtc: utc('2026-03-03T23:30:00Z'),
    });
    expect(planTaskReminders([late], settings(), { ...window, lists: [errands] })).toEqual([
      {
        body: 'Due today · 12:30 AM',
        expiresAt: utc('2026-03-04T23:00:00Z'),
        fireAt: utc('2026-03-03T23:30:00Z'),
        key: 'task:apple-reminders/rem-1:2026-03-04',
        since: 0,
        target: {
          accountId: APPLE_REMINDERS_ACCOUNT_ID,
          dueDate: '2026-03-03',
          dueUtc: utc('2026-03-03T23:30:00Z'),
          kind: 'task',
          listId: 'ek-errands',
          taskId: 'rem-1',
        },
        title: 'Call the bank',
      },
    ]);
    // The other way round, the instant's day is before the window.
    const early = reminder({ dueDate: '2026-03-04', dueUtc: utc('2026-03-03T22:00:00Z') });
    expect(planTaskReminders([early], settings(), { ...window, lists: [errands] })).toEqual([]);
  });

  it("dates a plan's subject from the later of the task's change and the settings' save", () => {
    const [plan] = planTaskReminders([task({ updatedAt: 5 })], settings(), { ...window, since: 9 });
    expect(plan?.since).toBe(9);
    expect(
      planTaskReminders([task({ updatedAt: 12 })], settings(), { ...window, since: 9 })[0]?.since,
    ).toBe(12);
  });

  it('names the list only when more than one is visible', () => {
    expect(planTaskReminders([task()], settings(), window)[0]!.body).toBe('Due today');
    expect(
      planTaskReminders([task()], settings(), { ...window, lists: [inbox, errands] })[0]!.body,
    ).toBe('Due today · Inbox');
  });

  it('skips done, undated, hidden-list and not-yet-pushed tasks, and everything when off', () => {
    const skipped = [
      task({ id: 'done', status: 'completed' }),
      task({ dueDate: undefined, id: 'undated' }),
      task({ id: 'hidden', listId: 'someday' }),
      task({ id: 'local-abc' }),
    ];
    expect(planTaskReminders(skipped, settings(), window)).toEqual([]);
    expect(planTaskReminders([task()], settings({ enabled: false }), window)).toEqual([]);
  });

  it('keeps the due day inside the window, both edges inclusive', () => {
    const plans = planTaskReminders(
      [
        task({ dueDate: '2026-03-03', id: 'before' }),
        task({ dueDate: '2026-03-11', id: 'last' }),
        task({ dueDate: '2026-03-12', id: 'after' }),
        task({ dueDate: '2026-03-04', id: 'first' }),
      ],
      settings(),
      window,
    );
    expect(plans.map((plan) => plan.key)).toEqual([
      'task:acc/first:2026-03-04',
      'task:acc/last:2026-03-11',
    ]);
  });

  it('a date this engine cannot read costs that task its notification, not the pass', () => {
    const plans = planTaskReminders(
      [task({ dueDate: '2026-03-04x', id: 'odd' }), task()],
      settings(),
      { ...window, untilDate: '2026-03-99' },
    );
    expect(plans.map((plan) => plan.key)).toEqual(['task:acc/t1:2026-03-04']);
  });
});
