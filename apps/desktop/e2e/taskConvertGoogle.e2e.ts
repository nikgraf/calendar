import { Account, APPLE_REMINDERS_ACCOUNT_ID, TaskListInfo, TaskRecord } from '@calendar/core';
import type { GoogleFixture } from '@calendar/sync/testing/googleFixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type App,
  launchApp,
  localIsoDaysAgo,
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
  accounts: [{ email: 'e2e@nikgraf.com', id: 'acc-e2e', tasksEnabled: true }],
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
    await cdp.eval(setSelect(LIST_SELECT, 'acc-e2e:list-e2e'));
    await cdp.waitFor(`document.body.textContent.includes('Edit task')`);
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
    await cdp.eval(setSelect(LIST_SELECT, `${APPLE_REMINDERS_ACCOUNT_ID}:ek-list-1`));
    await cdp.waitFor(`document.body.textContent.includes('Edit reminder')`);
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

  it('a Google task moved to another Google list is recreated there with a server id', async () => {
    const { cdp } = app;
    await open('Buy groceries', 'Edit task');
    await cdp.eval(setSelect(LIST_SELECT, 'acc-e2e:list-errands'));
    await cdp.clickButtonWithText('Save');
    await expect
      .poll(async () => {
        const tasks = await readTasks(app.userDataDir);
        const moved = tasks.find((task) => task.title === 'Buy groceries');
        return {
          gone: !tasks.some((task) => task.id === 'task-groceries'),
          listId: moved?.listId,
          pending: await readPendingOpsCount(app.userDataDir),
          serverId: isServerId(moved?.id),
        };
      })
      .toEqual({ gone: true, listId: 'list-errands', pending: 0, serverId: true });
    // Still on screen: a move never loses the chip.
    expect(await cdp.locate('[title="Buy groceries"]')).toBeTruthy();
  });
});
