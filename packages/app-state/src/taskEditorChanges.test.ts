import { describe, expect, it } from 'vitest';
import { taskEditorChanges, type TaskEditorValues } from './taskEditorChanges.ts';

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

  it('never touches a rule the form could not show', () => {
    expect(diff({ recurrence: undefined }, { recurrenceUnsupported: true })).toEqual({});
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
