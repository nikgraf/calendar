import {
  type PreviewEventToTaskParams,
  type RecurringScope,
  type TaskConvertValues,
  TaskListInfo,
} from '@calendar/core';
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

type Form = ReturnType<typeof useEventEditorModel>;

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
  showError: () => undefined,
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

describe('switchEditorMode on an occurrence of a series', () => {
  const rule = { freq: 'weekly', interval: 1 } as const;
  /** The third occurrence of `series`, as the grid hands it to the editor. */
  const occurrence = {
    accountId: 'google-a',
    calendarId: 'cal',
    id: 'series_20261024T090000Z',
    originalStartUtc: 1_792_832_400_000,
    recurringEventId: 'series',
    startUtc: 1_792_832_400_000,
  };

  /**
   * Flips the editor to a task at `scope`: what the backend was asked,
   * what the form took, and the scope Save was told the fields stand for.
   * `whilePreviewing` runs while the preview is on its way, as a click on
   * the event form's scope control would.
   */
  const convertAt = async (
    scope: RecurringScope,
    whilePreviewing?: (form: Form) => void,
    refusal?: Error,
  ) => {
    const asked: Array<PreviewEventToTaskParams> = [];
    const adopted: Array<TaskConvertValues> = [];
    const scopes: Array<RecurringScope> = [];
    const shown: Array<string | null> = [];
    const { model } = taskModel('google-a:inbox');
    const form: Form = {
      ...eventModel,
      existing: occurrence,
      scope,
      showError: (message: string | null) => {
        shown.push(message);
      },
    } as Form;
    const switched = await switchEditorMode({
      confirm: () => Promise.reject(new Error('an existing event asks on Save')),
      eventModel: form,
      from: 'event',
      next: 'task',
      previewEventToTask: (params) => {
        asked.push(params);
        whilePreviewing?.(form);
        if (refusal) {
          return Promise.reject(refusal);
        }
        return Promise.resolve({
          carriedRecurrence: rule,
          loss: {
            attendees: 0,
            dueTime: true,
            location: false,
            modifiedOccurrences: 0,
            recurrence: false,
            reminders: 0,
          },
        });
      },
      sourceKind: 'event',
      taskModel: {
        ...model,
        adopt: (next: TaskConvertValues) => adopted.push(next),
        setConvertScope: (next: RecurringScope) => scopes.push(next),
      } as typeof model,
      timeZone: 'UTC',
    });
    return { adopted, asked, scopes, shown, switched };
  };

  it('"This event" asks about that occurrence and tells Save so', async () => {
    const { adopted, asked, scopes, switched } = await convertAt('instance');
    expect(switched).toBe(true);
    expect(asked).toEqual([
      {
        accountId: 'google-a',
        calendarId: 'cal',
        eventId: 'series',
        occurrence: { originalStartUtc: occurrence.originalStartUtc },
        target: { accountId: 'google-a', taskListId: 'inbox' },
      },
    ]);
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ dueDate: '2026-10-10', title: 'x' });
    expect(scopes).toEqual(['instance']);
  });

  it('"All events" asks about the series and carries the rule the preview holds', async () => {
    const { adopted, asked, scopes } = await convertAt('series');
    expect(asked).toEqual([
      {
        accountId: 'google-a',
        calendarId: 'cal',
        eventId: 'series',
        target: { accountId: 'google-a', taskListId: 'inbox' },
      },
    ]);
    expect(adopted[0]?.recurrence).toEqual(rule);
    expect(scopes).toEqual(['series']);
  });

  it('Save is told the scope the carry was made for, not one picked while it loaded', async () => {
    const { asked, scopes } = await convertAt('instance', (form) => {
      (form as { scope: RecurringScope }).scope = 'series';
    });
    expect(asked[0]?.occurrence).toEqual({ originalStartUtc: occurrence.originalStartUtc });
    expect(scopes).toEqual(['instance']);
  });

  it('"This and following" does not switch: nothing is asked, carried or told', async () => {
    expect(await convertAt('following')).toEqual({
      adopted: [],
      asked: [],
      scopes: [],
      shown: [],
      switched: false,
    });
  });

  it('a preview the backend refuses keeps the event form, with the reason on it', async () => {
    const { adopted, asked, scopes, shown, switched } = await convertAt(
      'instance',
      undefined,
      new Error('EventNotFoundError'),
    );
    expect(switched).toBe(false);
    expect(asked).toHaveLength(1);
    expect(adopted).toEqual([]);
    expect(scopes).toEqual([]);
    expect(shown).toEqual(['Error: EventNotFoundError']);
  });

  it('a switch that goes through takes an earlier refusal off the event form', async () => {
    expect((await convertAt('instance')).shown).toEqual([null]);
  });
});
