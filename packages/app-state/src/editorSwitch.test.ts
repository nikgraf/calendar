import { TaskListInfo } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import type { useEventEditorModel } from './editorModel.ts';
import { switchEditorMode } from './editorSwitch.ts';
import type { useTaskEditorModel } from './taskEditorModel.ts';

const list = (accountId: string, id: string) =>
  new TaskListInfo({
    accountId,
    id,
    isVisible: true,
    provider: accountId === 'apple-reminders' ? 'apple' : 'google',
    title: id,
  });
const lists = [
  list('apple-reminders', 'reminders'),
  list('google-a', 'inbox'),
  list('google-a', 'errands'),
];

/** A task model in create mode, holding only what the switch reads and sets. */
const taskModel = (listKey: string) => {
  const picked: Array<string> = [];
  const model = {
    adopt: () => undefined,
    existing: undefined,
    listKey,
    offeredLists: lists,
    provider: listKey.startsWith('apple') ? 'apple' : 'google',
    setListKey: (key: string) => picked.push(key),
    values: () => ({ alarms: [], completed: false, dueDate: '2026-10-10', notes: '', title: 'x' }),
  } as unknown as ReturnType<typeof useTaskEditorModel>;
  return { model, picked };
};
const eventModel = {
  adopt: () => undefined,
  existing: undefined,
  targetProvider: 'google',
  values: () => ({
    attendees: [],
    date: '2026-10-10',
    defaultReminderMinutes: [],
    endTime: '10:00',
    isAllDay: false,
    reminders: { overrides: [], useDefault: true },
    startTime: '09:00',
    timeChosen: false,
    title: 'x',
  }),
} as unknown as ReturnType<typeof useEventEditorModel>;

const switchTo = (next: 'event' | 'reminder' | 'task', from: 'event' | 'todo', listKey: string) => {
  const { model, picked } = taskModel(listKey);
  return switchEditorMode({
    confirm: () => Promise.resolve(true),
    eventModel,
    from,
    next,
    previewEventToTask: () => Promise.reject(new Error('not an existing event')),
    sourceKind: 'new',
    taskModel: model,
    timeZone: 'UTC',
  }).then((switched) => ({ picked, switched }));
};

describe('switchEditorMode', () => {
  it('keeps a list already picked for the kind on the way back from the event form', async () => {
    expect(await switchTo('task', 'event', 'google-a:errands')).toEqual({
      picked: ['google-a:errands'],
      switched: true,
    });
  });

  it("picks the kind's default list when the picked one is the other provider's", async () => {
    expect(await switchTo('reminder', 'event', 'google-a:errands')).toEqual({
      picked: ['apple-reminders:reminders'],
      switched: true,
    });
    expect(await switchTo('task', 'todo', 'apple-reminders:reminders')).toEqual({
      picked: ['google-a:inbox'],
      switched: true,
    });
  });

  it('cannot switch to a kind without a list', async () => {
    const { model } = taskModel('google-a:inbox');
    const switched = await switchEditorMode({
      confirm: () => Promise.resolve(true),
      eventModel,
      from: 'todo',
      next: 'reminder',
      previewEventToTask: () => Promise.reject(new Error('unused')),
      sourceKind: 'new',
      taskModel: { ...model, offeredLists: lists.slice(1) } as typeof model,
      timeZone: 'UTC',
    });
    expect(switched).toBe(false);
  });
});
