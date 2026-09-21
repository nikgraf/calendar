import { Account, APPLE_REMINDERS_ACCOUNT_ID, TaskListInfo, TaskRecord } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type App,
  launchApp,
  localIsoDaysAgo,
  readPendingOps,
  readTasks,
  type RemindersFixture,
} from './harness.ts';

// A Google account and the Reminders account side by side: the task
// editor's list picker spans both, and picking a list elsewhere moves the
// task on Save. Reminders come from the in-memory EventKit fixture, Google
// writes land in the op queue (no token, so they stay there).
const isoToday = localIsoDaysAgo(0);

const seed = {
  accounts: [
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      email: 'e2e@nikgraf.com',
      id: 'acc-e2e',
      provider: 'google',
      status: 'ok',
      tasksEnabled: true,
    }),
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
      accountId: 'acc-e2e',
      id: 'list-e2e',
      isVisible: true,
      provider: 'google',
      title: 'My Tasks',
    }),
    new TaskListInfo({
      accountId: 'acc-e2e',
      id: 'list-errands',
      isVisible: true,
      provider: 'google',
      title: 'Errands',
    }),
    new TaskListInfo({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      colorHex: '#ff0000',
      id: 'ek-list-1',
      isVisible: true,
      provider: 'apple',
      title: 'Reminders',
    }),
  ],
  tasks: [
    new TaskRecord({
      accountId: 'acc-e2e',
      dueDate: isoToday,
      id: 'task-rent',
      listId: 'list-e2e',
      provider: 'google',
      status: 'needsAction',
      title: 'Pay rent',
      updatedAt: 1,
    }),
    new TaskRecord({
      accountId: 'acc-e2e',
      dueDate: isoToday,
      id: 'task-groceries',
      listId: 'list-e2e',
      provider: 'google',
      status: 'needsAction',
      title: 'Buy groceries',
      updatedAt: 1,
    }),
    new TaskRecord({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      alarms: [-15],
      dueDate: isoToday,
      dueTime: '14:00',
      id: 'ek-rem-1',
      listId: 'ek-list-1',
      priority: 'high',
      provider: 'apple',
      status: 'needsAction',
      title: 'Call mom',
      updatedAt: 1,
    }),
  ],
};

const remindersFixture: RemindersFixture = {
  lists: [{ allowsModifications: true, colorHex: '#ff0000', id: 'ek-list-1', title: 'Reminders' }],
  reminders: [
    {
      alarms: [-15],
      completed: false,
      dueDate: isoToday,
      dueTime: '14:00',
      id: 'ek-rem-1',
      listId: 'ek-list-1',
      priority: 1,
      title: 'Call mom',
      updatedAt: 1,
    },
  ],
};

const setSelect = (selector: string, value: string) => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  const proto = window.HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, ${JSON.stringify(value)});
  element.dispatchEvent(new Event('change', { bubbles: true }));
})()`;

const LIST_SELECT = 'select[aria-label="Task list"]';

describe('Converting tasks between Google Tasks and Reminders', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { reminders: { fixture: remindersFixture } });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  /** Opens a task chip's editor by its body, away from the leading checkbox. */
  const open = async (testId: string, heading: string) => {
    const chip = await app.cdp.locate(`[data-testid="${testId}"]`);
    await app.cdp.click(chip.x + 40, chip.y);
    await app.cdp.waitFor(`document.body.textContent.includes(${JSON.stringify(heading)})`);
  };

  it('offers the lists of both providers, grouped per account', async () => {
    const { cdp } = app;
    await open('all-day-task-task-rent', 'Edit task');
    try {
      const groups = await cdp.waitFor<string>(
        `JSON.stringify([...document.querySelectorAll('${LIST_SELECT} optgroup')].map(g => [g.label, [...g.querySelectorAll('option')].map(o => o.value)]))`,
      );
      expect(JSON.parse(groups)).toEqual([
        // Lists come back sorted by title.
        ['e2e@nikgraf.com', ['acc-e2e:list-errands', 'acc-e2e:list-e2e']],
        ['Apple Reminders', [`${APPLE_REMINDERS_ACCOUNT_ID}:ek-list-1`]],
      ]);
      expect(await cdp.eval(`document.querySelector('${LIST_SELECT}').disabled`)).toBe(false);
    } finally {
      await cdp.clickButtonWithText('Cancel');
    }
  });

  it('moves a reminder to a Google list after confirming what is dropped', async () => {
    const { cdp } = app;
    await open('timed-task-ek-rem-1', 'Edit reminder');
    await cdp.eval(setSelect(LIST_SELECT, 'acc-e2e:list-e2e'));
    // The form follows the picked list: the Google one has no time field.
    await cdp.waitFor(`document.body.textContent.includes('Edit task')`);
    expect(await cdp.eval(`!!document.querySelector('input[aria-label="Due time"]')`)).toBe(false);
    await cdp.clickButtonWithText('Save');
    const summary = await cdp.waitFor<string>(
      `document.querySelector('[data-testid="move-confirm"]')?.textContent ?? ''`,
    );
    expect(summary).toContain('the due time');
    expect(summary).toContain('1 alert');
    expect(summary).toContain('the priority');
    await cdp.clickButtonWithText('Move anyway');
    await expect
      .poll(async () => {
        const tasks = await readTasks(app.userDataDir);
        const moved = tasks.find((task) => task.title === 'Call mom');
        return {
          dueTime: moved?.dueTime,
          gone: !tasks.some((task) => task.id === 'ek-rem-1'),
          listId: moved?.listId,
          local: moved?.id.startsWith('local-'),
          provider: moved?.provider,
        };
      })
      .toEqual({
        dueTime: undefined,
        gone: true,
        listId: 'list-e2e',
        local: true,
        provider: 'google',
      });
    const ops = await readPendingOps(app.userDataDir);
    expect(ops.some((op) => op.kind === 'createTask' && op.taskTitle === 'Call mom')).toBe(true);
    // Date-only now: an all-day chip, no timed block.
    expect(await cdp.locate('[title="Call mom"]')).toBeTruthy();
    expect(await cdp.eval(`!!document.querySelector('[data-testid="timed-task-ek-rem-1"]')`)).toBe(
      false,
    );
  });

  it('moves a Google task into Reminders with a due time, no confirmation needed', async () => {
    const { cdp } = app;
    await open('all-day-task-task-rent', 'Edit task');
    await cdp.eval(setSelect(LIST_SELECT, `${APPLE_REMINDERS_ACCOUNT_ID}:ek-list-1`));
    await cdp.waitFor(`document.body.textContent.includes('Edit reminder')`);
    await cdp.eval(`document.querySelector('input[aria-label="At a time"]').click()`);
    await cdp.clickButtonWithText('Save');
    await expect
      .poll(async () => {
        const tasks = await readTasks(app.userDataDir);
        const moved = tasks.find((task) => task.title === 'Pay rent');
        return {
          gone: !tasks.some((task) => task.id === 'task-rent'),
          listId: moved?.listId,
          provider: moved?.provider,
          timed: moved?.dueTime !== undefined,
        };
      })
      .toEqual({ gone: true, listId: 'ek-list-1', provider: 'apple', timed: true });
    expect(await cdp.eval(`!!document.querySelector('[data-testid="move-confirm"]')`)).toBe(false);
    const ops = await readPendingOps(app.userDataDir);
    expect(ops.some((op) => op.kind === 'deleteTask' && op.eventId === 'task-rent')).toBe(true);
    expect(await cdp.locate('[data-testid^="timed-task-"][title^="Pay rent"]')).toBeTruthy();
  });

  it('moves a Google task to another Google list through the queue', async () => {
    const { cdp } = app;
    await open('all-day-task-task-groceries', 'Edit task');
    await cdp.eval(setSelect(LIST_SELECT, 'acc-e2e:list-errands'));
    await cdp.clickButtonWithText('Save');
    await expect
      .poll(async () => {
        const tasks = await readTasks(app.userDataDir);
        const moved = tasks.find((task) => task.title === 'Buy groceries');
        return {
          gone: !tasks.some((task) => task.id === 'task-groceries'),
          listId: moved?.listId,
          local: moved?.id.startsWith('local-'),
        };
      })
      .toEqual({ gone: true, listId: 'list-errands', local: true });
    const ops = await readPendingOps(app.userDataDir);
    expect(ops.some((op) => op.kind === 'createTask' && op.taskTitle === 'Buy groceries')).toBe(
      true,
    );
    expect(ops.some((op) => op.kind === 'deleteTask' && op.eventId === 'task-groceries')).toBe(
      true,
    );
    expect(await cdp.eval(`!!document.querySelector('[data-testid="move-confirm"]')`)).toBe(false);
  });
});
