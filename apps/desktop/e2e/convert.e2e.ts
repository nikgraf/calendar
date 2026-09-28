import {
  Account,
  APPLE_REMINDERS_ACCOUNT_ID,
  CalendarInfo,
  EventRecord,
  TaskListInfo,
  TaskRecord,
} from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type App,
  launchApp,
  localIsoDaysAgo,
  readEvents,
  readPendingOps,
  readTasks,
  type RemindersFixture,
} from './harness.ts';

// A Google account (no token: writes stay queued) next to the Reminders
// fixture. The editor's Event | Task toggle carries a new draft across
// and converts an existing item on Save; it asks only when a filled
// field has no home on the other side.
const isoToday = localIsoDaysAgo(0);
/** Today at the given UTC hour: mid-day, so local and UTC dates agree. */
const todayAt = (hour: number): number => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour);
};
const HOUR_MS = 60 * 60 * 1000;

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
  calendars: [
    new CalendarInfo({
      accessRole: 'owner',
      accountId: 'acc-e2e',
      colorHex: '#3b82f6',
      id: 'cal-e2e',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'Work',
      timeZone: 'Europe/Vienna',
    }),
  ],
  events: [
    new EventRecord({
      accountId: 'acc-e2e',
      calendarId: 'cal-e2e',
      endUtc: todayAt(11) + HOUR_MS,
      etag: '"e2e"',
      id: 'evt-plain',
      isAllDay: false,
      startTimeZone: 'Europe/Vienna',
      startUtc: todayAt(11),
      status: 'confirmed',
      syncedAt: 1,
      syncStatus: 'synced',
      title: 'Plain event',
      updatedAt: 1,
    }),
  ],
  // Only the Reminders list: a new task defaults to it, and a timed draft
  // switches without a question (a Google list would drop the time).
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

const setField = (selector: string, value: string, kind: 'input' | 'select') => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  const proto = ${kind === 'input' ? 'window.HTMLInputElement' : 'window.HTMLSelectElement'}.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, ${JSON.stringify(value)});
  element.dispatchEvent(new Event(${JSON.stringify(kind === 'input' ? 'input' : 'change')}, { bubbles: true }));
})()`;

const TITLE = 'input[placeholder="Title"]';
const LIST_SELECT = 'select[aria-label="Task list"]';
const CONFIRM = `document.querySelector('[data-testid="move-confirm"]')`;
const heading = (text: string) => `document.body.textContent.includes(${JSON.stringify(text)})`;

describe('Converting between events and tasks', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { reminders: { fixture: remindersFixture } });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  const clickTestId = async (testId: string) => {
    const point = await app.cdp.locate(`[data-testid="${testId}"]`);
    await app.cdp.click(point.x, point.y);
  };

  it('switches a new draft between the kinds, asking only when a filled field would be lost', async () => {
    const { cdp } = app;
    // The lists (and the reminder) are loaded once its chip renders: the
    // task form's default list is read when the editor opens.
    await cdp.locate('[data-testid="timed-task-ek-rem-1"]');
    const button = await cdp.locate('[aria-label="New event"]');
    await cdp.click(button.x, button.y);
    await cdp.waitFor(heading('New event'));
    await cdp.eval(setField(TITLE, 'Water plants', 'input'));
    // A chosen time (the untouched 09:00 default is not one) follows the draft.
    await cdp.eval(setField('input[type="time"]', '10:30', 'input'));
    // Title, day and time all fit a reminder: no question.
    await clickTestId('mode-task');
    await cdp.waitFor(heading('New task'));
    expect(await cdp.eval(`!!${CONFIRM}`)).toBe(false);
    expect(await cdp.eval(`document.querySelector('${TITLE}').value`)).toBe('Water plants');
    expect(await cdp.eval(`document.querySelector('input[aria-label="At a time"]').checked`)).toBe(
      true,
    );
    expect(await cdp.eval(`document.querySelector('input[aria-label="Due time"]').value`)).toBe(
      '10:30',
    );
    // Back to the event, and a location makes the next switch lossy.
    await clickTestId('mode-event');
    await cdp.waitFor(heading('New event'));
    await cdp.eval(setField('input[aria-label="Location"]', 'Room 4B', 'input'));
    await clickTestId('mode-task');
    const summary = await cdp.waitFor<string>(`${CONFIRM}?.textContent ?? ''`);
    expect(summary).toContain('Switching to a task drops the location.');
    await cdp.clickButtonWithText('Keep as event');
    expect(await cdp.eval(heading('New event'))).toBe(true);
    await clickTestId('mode-task');
    await cdp.waitFor(`!!${CONFIRM}`);
    await cdp.clickButtonWithText('Switch');
    await cdp.waitFor(heading('New task'));
    expect(await cdp.eval(`document.querySelector('${TITLE}').value`)).toBe('Water plants');
    await cdp.clickButtonWithText('Cancel');
    await cdp.waitFor(`!${heading('New task')}`);
  });

  it('converts an event into a reminder without asking when nothing is lost', async () => {
    const { cdp } = app;
    const block = await cdp.locate('[title^="Plain event"]');
    await cdp.click(block.x, block.y);
    await cdp.waitFor(heading('Edit event'));
    await clickTestId('mode-task');
    await cdp.waitFor(heading('Convert to reminder'));
    expect(await cdp.eval(`document.querySelector('${TITLE}').value`)).toBe('Plain event');
    expect(await cdp.eval(`document.querySelector('input[aria-label="At a time"]').checked`)).toBe(
      true,
    );
    expect(await cdp.eval(`document.querySelector('${LIST_SELECT}').value`)).toBe(
      `${APPLE_REMINDERS_ACCOUNT_ID}:ek-list-1`,
    );
    await cdp.clickButtonWithText('Save');
    await expect
      .poll(async () => {
        const tasks = await readTasks(app.userDataDir);
        const converted = tasks.find((task) => task.title === 'Plain event');
        const events = await readEvents(app.userDataDir);
        return {
          eventGone: !events.some((event) => event.id === 'evt-plain'),
          listId: converted?.listId,
          provider: converted?.provider,
          timed: converted?.dueTime !== undefined,
        };
      })
      .toEqual({ eventGone: true, listId: 'ek-list-1', provider: 'apple', timed: true });
    expect(await cdp.eval(`!!${CONFIRM}`)).toBe(false);
    const ops = await readPendingOps(app.userDataDir);
    expect(ops.some((op) => op.kind === 'delete' && op.eventId === 'evt-plain')).toBe(true);
    expect(await cdp.locate('[data-testid^="timed-task-"][title^="Plain event"]')).toBeTruthy();
  });

  it('converts a reminder into an event after confirming what it drops', async () => {
    const { cdp } = app;
    const chip = await cdp.locate('[data-testid="timed-task-ek-rem-1"]');
    await cdp.click(chip.x + 40, chip.y);
    await cdp.waitFor(heading('Edit reminder'));
    await clickTestId('mode-event');
    await cdp.waitFor(heading('Convert to event'));
    expect(await cdp.eval(`document.querySelector('${TITLE}').value`)).toBe('Call mom');
    await cdp.clickButtonWithText('Save');
    const summary = await cdp.waitFor<string>(`${CONFIRM}?.textContent ?? ''`);
    expect(summary).toContain('Converting this task to an event drops the priority.');
    await cdp.clickButtonWithText('Keep as task');
    expect(await cdp.eval(heading('Convert to event'))).toBe(true);
    expect((await readTasks(app.userDataDir)).some((task) => task.id === 'ek-rem-1')).toBe(true);
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!!${CONFIRM}`);
    await cdp.clickButtonWithText('Convert anyway');
    await expect
      .poll(async () => {
        const tasks = await readTasks(app.userDataDir);
        const ops = await readPendingOps(app.userDataDir);
        return {
          created: ops.some((op) => op.kind === 'create' && op.payload?.title === 'Call mom'),
          reminderGone: !tasks.some((task) => task.id === 'ek-rem-1'),
        };
      })
      .toEqual({ created: true, reminderGone: true });
    expect(await cdp.locate('[title^="Call mom"]')).toBeTruthy();
  });
});
