import { Account, APPLE_REMINDERS_ACCOUNT_ID, TaskListInfo, TaskRecord } from '@calendar/core';
import type { GoogleFixture } from '@calendar/sync/testing/googleFixture';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  type App,
  launchApp,
  localIsoDaysAgo,
  readEvents,
  readPendingOpsCount,
  readTasks,
  type RemindersFixture,
} from './harness.ts';

// The sibling of taskConvert.e2e.ts with Google answered by the in-process
// fake API (CALENDAR_GOOGLE=fixture): the Google lists and tasks arrive
// through the first sync, and every queued write pushes — so the temp
// `local-…` id of a converted task becomes a server id and the queue
// drains, which the tokenless suite can never show.
const isoToday = localIsoDaysAgo(0);

const googleFixture: GoogleFixture = {
  accounts: [{ email: 'e2e@example.com', id: 'acc-e2e', tasksEnabled: true }],
  // Where a converted task lands.
  calendars: [{ accessRole: 'owner', id: 'cal-e2e', primary: true, summary: 'Work' }],
  taskLists: [
    { id: 'list-e2e', title: 'My Tasks' },
    { id: 'list-errands', title: 'Errands' },
  ],
  tasks: {
    'list-e2e': [
      {
        due: `${isoToday}T00:00:00.000Z`,
        id: 'task-rent',
        status: 'needsAction',
        title: 'Pay rent',
        updated: '2026-01-01T00:00:00.000Z',
      },
      {
        due: `${isoToday}T00:00:00.000Z`,
        id: 'task-groceries',
        status: 'needsAction',
        title: 'Buy groceries',
        updated: '2026-01-01T00:00:00.000Z',
      },
      // A subtask: a move of its parent takes it along.
      {
        due: `${isoToday}T00:00:00.000Z`,
        id: 'task-milk',
        parent: 'task-groceries',
        position: '00000000000000000000',
        status: 'needsAction',
        title: 'Milk',
        updated: '2026-01-01T00:00:00.000Z',
      },
      // Parents a delete and a conversion take their subtasks with, as Google does.
      ...[
        { id: 'task-trip', title: 'Plan trip' },
        { id: 'task-passport', parent: 'task-trip', title: 'Renew passport' },
        { id: 'task-visa', parent: 'task-trip', title: 'Apply for visa' },
        { id: 'task-party', title: 'Plan party' },
        { id: 'task-cake', parent: 'task-party', title: 'Order cake' },
      ].map(({ id, parent, title }, index) => ({
        due: `${isoToday}T00:00:00.000Z`,
        id,
        ...(parent === undefined ? {} : { parent, position: String(index).padStart(20, '0') }),
        status: 'needsAction' as const,
        title,
        updated: '2026-01-01T00:00:00.000Z',
      })),
    ],
  },
};

const seed = {
  accounts: [
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      email: 'e2e@example.com',
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
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
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
      alarms: [],
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
const isServerId = (id: string | undefined) => id !== undefined && !id.startsWith('local-');

describe('Converting tasks against the fake Google API', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, {
      google: { fixture: googleFixture },
      reminders: { fixture: remindersFixture },
    });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  const open = async (title: string, heading: string) => {
    const chip = await app.cdp.locate(`[title=${JSON.stringify(title)}]`);
    await app.cdp.click(chip.x + 40, chip.y);
    await app.cdp.waitFor(`document.body.textContent.includes(${JSON.stringify(heading)})`);
  };
  const clickTestId = async (testId: string) => {
    const point = await app.cdp.locate(`[data-testid="${testId}"]`);
    await app.cdp.click(point.x, point.y);
  };

  it('mirrors the fixture lists and tasks on launch', async () => {
    expect(await app.cdp.locate('[title="Pay rent"]')).toBeTruthy();
    const tasks = await readTasks(app.userDataDir);
    expect(tasks.filter((task) => task.provider === 'google').map((task) => task.id)).toEqual(
      expect.arrayContaining(['task-rent', 'task-groceries']),
    );
    expect(await readPendingOpsCount(app.userDataDir)).toBe(0);
  });

  it('a reminder moved to Google pushes and gets a server id', async () => {
    const { cdp } = app;
    const chip = await cdp.locate('[data-testid="timed-task-ek-rem-1"]');
    await cdp.click(chip.x + 40, chip.y);
    await cdp.waitFor(`document.body.textContent.includes('Edit reminder')`);
    await clickTestId('mode-task');
    await cdp.waitFor(`document.body.textContent.includes('Move to task')`);
    await cdp.eval(setSelect(LIST_SELECT, 'acc-e2e:list-e2e'));
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!!document.querySelector('[data-testid="move-confirm"]')`);
    await cdp.clickButtonWithText('Move anyway');
    await expect
      .poll(async () => {
        const tasks = await readTasks(app.userDataDir);
        const moved = tasks.find((task) => task.title === 'Call mom');
        return {
          gone: !tasks.some((task) => task.id === 'ek-rem-1'),
          listId: moved?.listId,
          pending: await readPendingOpsCount(app.userDataDir),
          serverId: isServerId(moved?.id),
        };
      })
      .toEqual({ gone: true, listId: 'list-e2e', pending: 0, serverId: true });
    expect(await cdp.locate('[title="Call mom"]')).toBeTruthy();
  });

  it('a Google task moved to Reminders is deleted upstream', async () => {
    const { cdp } = app;
    await open('Pay rent', 'Edit task');
    await clickTestId('mode-reminder');
    await cdp.waitFor(`document.body.textContent.includes('Move to reminder')`);
    expect(await cdp.eval(`document.querySelector('${LIST_SELECT}').value`)).toBe(
      `${APPLE_REMINDERS_ACCOUNT_ID}:ek-list-1`,
    );
    await cdp.clickButtonWithText('Save');
    await expect
      .poll(async () => {
        const tasks = await readTasks(app.userDataDir);
        const moved = tasks.find((task) => task.title === 'Pay rent');
        return {
          gone: !tasks.some((task) => task.id === 'task-rent'),
          listId: moved?.listId,
          pending: await readPendingOpsCount(app.userDataDir),
          provider: moved?.provider,
        };
      })
      .toEqual({ gone: true, listId: 'ek-list-1', pending: 0, provider: 'apple' });
    expect(await cdp.eval(`!!document.querySelector('[data-testid="move-confirm"]')`)).toBe(false);
  });

  it('a Google task moved to another Google list keeps its id and takes its subtask along', async () => {
    const { cdp } = app;
    await open('Buy groceries', 'Edit task');
    await cdp.eval(setSelect(LIST_SELECT, 'acc-e2e:list-errands'));
    await cdp.clickButtonWithText('Save');
    await expect
      .poll(async () => {
        const tasks = await readTasks(app.userDataDir);
        const where = (id: string) => {
          const row = tasks.find((task) => task.id === id);
          return row && `${row.listId}<${row.parentId ?? ''}`;
        };
        return {
          groceries: where('task-groceries'),
          milk: where('task-milk'),
          pending: await readPendingOpsCount(app.userDataDir),
        };
      })
      .toEqual({ groceries: 'list-errands<', milk: 'list-errands<task-groceries', pending: 0 });
    // Nothing lost, so nothing asked.
    expect(await cdp.eval(`!!document.querySelector('[data-testid="move-confirm"]')`)).toBe(false);
    // Still on screen: a move never loses the chip.
    expect(await cdp.locate('[title="Buy groceries"]')).toBeTruthy();
  });

  it('a subtask moved to another list asks first, then becomes a task of its own', async () => {
    const { cdp } = app;
    await open('Milk', 'Edit task');
    await cdp.eval(setSelect(LIST_SELECT, 'acc-e2e:list-e2e'));
    await cdp.clickButtonWithText('Save');
    const summary = await cdp.waitFor<string>(
      `document.querySelector('[data-testid="move-confirm"]')?.textContent ?? ''`,
    );
    expect(summary).toContain('It is a subtask: in the new list it becomes a task of its own.');
    await cdp.clickButtonWithText('Move anyway');
    await expect
      .poll(async () => {
        const milk = (await readTasks(app.userDataDir)).find((task) => task.id === 'task-milk');
        return {
          at: milk && `${milk.listId}<${milk.parentId ?? ''}`,
          pending: await readPendingOpsCount(app.userDataDir),
        };
      })
      .toEqual({ at: 'list-e2e<', pending: 0 });
  });

  const CONFIRM = `document.querySelector('[data-testid="move-confirm"]')`;
  const remaining = async (ids: ReadonlyArray<string>) =>
    (await readTasks(app.userDataDir))
      .filter((task) => ids.includes(task.id))
      .map((task) => task.id);

  it('deleting a parent task names its subtasks, then takes them along', async () => {
    const { cdp } = app;
    const family = ['task-trip', 'task-passport', 'task-visa'];
    await open('Plan trip', 'Edit task');
    await cdp.clickButtonWithText('Delete');
    const question = await cdp.waitFor<string>(`${CONFIRM}?.textContent ?? ''`);
    expect(question).toContain('Delete “Plan trip” and its 2 subtasks?');
    await cdp.confirmDelete();
    // Gone here at once, and the three deletes pushed.
    await expect
      .poll(async () => ({
        left: await remaining(family),
        pending: await readPendingOpsCount(app.userDataDir),
      }))
      .toEqual({ left: [], pending: 0 });
    await cdp.waitFor(`!document.querySelector('[title="Renew passport"]')`);
  });

  it('converting a parent task to an event names its subtask before deleting it', async () => {
    const { cdp } = app;
    const family = ['task-party', 'task-cake'];
    await open('Plan party', 'Edit task');
    await clickTestId('mode-event');
    await cdp.waitFor(`document.body.textContent.includes('Convert to event')`);
    await cdp.clickButtonWithText('Save');
    const summary = await cdp.waitFor<string>(`${CONFIRM}?.textContent ?? ''`);
    expect(summary).toContain('Converting this task to an event deletes its subtask.');
    await cdp.clickButtonWithText('Keep as task');
    expect(await remaining(family)).toEqual(expect.arrayContaining(family));
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!!${CONFIRM}`);
    await cdp.clickButtonWithText('Convert anyway');
    await expect
      .poll(async () => ({
        event: (await readEvents(app.userDataDir)).some((event) => event.title === 'Plan party'),
        left: await remaining(family),
        pending: await readPendingOpsCount(app.userDataDir),
      }))
      .toEqual({ event: true, left: [], pending: 0 });
  });
});
