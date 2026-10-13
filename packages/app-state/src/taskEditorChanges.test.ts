import { TaskListInfo, TaskRecord } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { offeredTaskLists, taskEditorChanges, type TaskEditorValues } from './taskEditorChanges.ts';

const listInfo = (overrides: Partial<TaskListInfo>) =>
  new TaskListInfo({
    accountId: 'apple-reminders',
    id: 'l',
    isVisible: true,
    provider: 'apple',
    title: 'List',
    ...overrides,
  });

const lists = [
  listInfo({ id: 'apple-rw' }),
  listInfo({ id: 'apple-ro', readOnly: true }),
  listInfo({ accountId: 'google-1', id: 'google', provider: 'google' }),
];

const reminderIn = (listId: string) =>
  new TaskRecord({
    accountId: 'apple-reminders',
    id: 'r',
    listId,
    provider: 'apple',
    status: 'needsAction',
    title: 'Dentist',
    updatedAt: 1,
  });

describe('offeredTaskLists', () => {
  it('creating offers every writable list of every provider', () => {
    expect(offeredTaskLists(lists, undefined).map((list) => list.id)).toEqual([
      'apple-rw',
      'google',
    ]);
  });

  it('editing offers every writable list of every account, never a read-only target', () => {
    expect(offeredTaskLists(lists, reminderIn('apple-rw')).map((list) => list.id)).toEqual([
      'apple-rw',
      'google',
    ]);
  });

  it('a task already in a read-only list still sees where it lives', () => {
    expect(offeredTaskLists(lists, reminderIn('apple-ro')).map((list) => list.id)).toEqual([
      'apple-rw',
      'apple-ro',
      'google',
    ]);
  });
});

const initial: TaskEditorValues = {
  alarm: -15,
  dueDate: '2030-03-10',
  dueTime: '09:00',
  listId: 'list-a',
  notes: 'bring the form',
  priority: 'high',
  recurrence: { freq: 'weekly', interval: 2 },
  title: 'Dentist',
  url: 'https://example.com',
};

const diff = (
  current: Partial<TaskEditorValues>,
  options: { provider?: 'apple' | 'google'; recurrenceUnsupported?: boolean } = {},
) =>
  taskEditorChanges({
    current: { ...initial, ...current },
    initial,
    initialAlarms: [-15, -1440],
    provider: options.provider ?? 'apple',
    recurrenceUnsupported: options.recurrenceUnsupported ?? false,
  });

describe('taskEditorChanges', () => {
  it('sends nothing when nothing changed', () => {
    // A repeat rule rebuilt from the form is a new object with equal fields.
    expect(diff({ recurrence: { freq: 'weekly', interval: 2 } })).toEqual({});
  });

  it('sends only the edited field — the rest stays whatever Reminders holds now', () => {
    expect(diff({ title: 'Dentist (moved)' })).toEqual({ title: 'Dentist (moved)' });
  });

  it('clears reminder fields with null and keeps trailing alarms on an alert change', () => {
    expect(
      diff({
        alarm: undefined,
        dueTime: undefined,
        priority: undefined,
        recurrence: undefined,
        url: '',
      }),
    ).toEqual({
      alarms: [-1440],
      dueTime: null,
      priority: null,
      recurrence: null,
      url: null,
    });
    expect(diff({ alarm: 0 })).toEqual({ alarms: [0, -1440] });
  });

  it('clearing the only alarm sends null', () => {
    expect(
      taskEditorChanges({
        current: { ...initial, alarm: undefined },
        initial,
        initialAlarms: [-15],
        provider: 'apple',
        recurrenceUnsupported: false,
      }),
    ).toEqual({ alarms: null });
  });

  it('a list change becomes moveToListId', () => {
    expect(diff({ listId: 'list-b' })).toEqual({ moveToListId: 'list-b' });
  });

  it('compares weekdays order-insensitively and sends a changed set', () => {
    const weekends = {
      byDay: [{ weekday: 'SA' as const }, { weekday: 'SU' as const }],
      freq: 'weekly' as const,
      interval: 1,
    };
    const seeded = { ...initial, recurrence: weekends };
    const diffFrom = (recurrence: TaskEditorValues['recurrence']) =>
      taskEditorChanges({
        current: { ...seeded, recurrence },
        initial: seeded,
        initialAlarms: [-15],
        provider: 'apple',
        recurrenceUnsupported: false,
      });
    expect(diffFrom({ ...weekends, byDay: [{ weekday: 'SU' }, { weekday: 'SA' }] })).toEqual({});
    const withMonday = { ...weekends, byDay: [{ weekday: 'MO' as const }, ...weekends.byDay] };
    expect(diffFrom(withMonday)).toEqual({ recurrence: withMonday });
    expect(diffFrom({ freq: 'weekly', interval: 1 })).toEqual({
      recurrence: { freq: 'weekly', interval: 1 },
    });
  });

  it('never touches a rule the form could not show', () => {
    expect(diff({ recurrence: undefined }, { recurrenceUnsupported: true })).toEqual({});
  });

  it('leaves an undated task undated until a due day is added', () => {
    const undated = { ...initial, dueDate: undefined, dueTime: undefined };
    const changes = (current: Partial<TaskEditorValues>) =>
      taskEditorChanges({
        current: { ...undated, ...current },
        initial: undated,
        initialAlarms: [-15, -1440],
        provider: 'apple',
        recurrenceUnsupported: false,
      });
    expect(changes({ title: 'Renamed' })).toEqual({ title: 'Renamed' });
    expect(changes({ dueDate: '2030-03-11' })).toEqual({ dueDate: '2030-03-11' });
    // A day and a rule picked, then the day taken away again before Save:
    // the hidden rule is not sent (EventKit refuses a repeat without a day).
    expect(
      taskEditorChanges({
        current: { ...undated, recurrence: { freq: 'daily', interval: 1 } },
        initial: { ...undated, recurrence: undefined },
        initialAlarms: [],
        provider: 'apple',
        recurrenceUnsupported: false,
      }),
    ).toEqual({});
  });

  it("takes a due day away with null, and the reminder's time and repeat rule with it", () => {
    // The time goes with the day; EventKit refuses a repeat without one.
    expect(diff({ dueDate: undefined, dueTime: undefined })).toEqual({
      dueDate: null,
      recurrence: null,
    });
    // Whatever the hidden rows still hold.
    expect(diff({ dueDate: undefined })).toEqual({ dueDate: null, recurrence: null });
    expect(diff({ dueDate: undefined }, { provider: 'google' })).toEqual({ dueDate: null });
    // The rest of the form still counts.
    expect(diff({ dueDate: undefined, title: 'Dentist, some day' })).toEqual({
      dueDate: null,
      recurrence: null,
      title: 'Dentist, some day',
    });
  });

  it('a Google task only ever sends title, notes, and due date', () => {
    expect(
      diff(
        { dueDate: '2030-03-11', notes: '', priority: undefined, url: '' },
        { provider: 'google' },
      ),
    ).toEqual({ dueDate: '2030-03-11', notes: '' });
  });
});
