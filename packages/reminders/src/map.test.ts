import { describe, expect, it } from 'vitest';
import {
  mapReminder,
  mapReminderList,
  priorityFromEventKit,
  priorityToEventKit,
  toReminderWrite,
} from './map.ts';
import type { ReminderJson } from './protocol.ts';

const base: ReminderJson = {
  alarms: [],
  completed: false,
  id: 'r1',
  listId: 'list-a',
  priority: 0,
  title: 'Call mom',
  updatedAt: 1000,
};

describe('priority buckets', () => {
  it('collapses EventKit 0…9 into none/high/medium/low and writes back the Reminders values', () => {
    expect(priorityFromEventKit(0)).toBeUndefined();
    expect(priorityFromEventKit(1)).toBe('high');
    expect(priorityFromEventKit(4)).toBe('high');
    expect(priorityFromEventKit(5)).toBe('medium');
    expect(priorityFromEventKit(6)).toBe('low');
    expect(priorityFromEventKit(9)).toBe('low');
    expect(priorityToEventKit('high')).toBe(1);
    expect(priorityToEventKit('medium')).toBe(5);
    expect(priorityToEventKit('low')).toBe(9);
    expect(priorityToEventKit(undefined)).toBe(0);
    expect(priorityToEventKit(null)).toBe(0);
  });
});

describe('mapReminder', () => {
  it('maps a timed, prioritised, repeating reminder', () => {
    const record = mapReminder(
      {
        ...base,
        alarms: [-15, 0],
        dueDate: '2030-01-02',
        dueTime: '14:30',
        notes: 'bring the form',
        priority: 5,
        recurrence: { freq: 'weekly', interval: 2, untilDate: '2030-06-01' },
        url: 'https://example.com',
      },
      'apple-reminders',
    );
    expect(record.provider).toBe('apple');
    expect(record.dueDate).toBe('2030-01-02');
    expect(record.dueTime).toBe('14:30');
    expect(record.priority).toBe('medium');
    expect(record.alarms).toEqual([-15, 0]);
    expect(record.recurrence).toEqual({ freq: 'weekly', interval: 2, untilDate: '2030-06-01' });
    expect(record.recurrenceUnsupported).toBeUndefined();
    expect(record.url).toBe('https://example.com');
    expect(record.status).toBe('needsAction');
  });

  it('keeps an all-day reminder date-only and flags exotic rules as unsupported', () => {
    const record = mapReminder(
      {
        ...base,
        completed: true,
        completedAt: 5,
        dueDate: '2030-01-02',
        recurrence: { unsupported: true },
      },
      'apple-reminders',
    );
    expect(record.dueTime).toBeUndefined();
    expect(record.recurrence).toBeUndefined();
    expect(record.recurrenceUnsupported).toBe(true);
    expect(record.status).toBe('completed');
    expect(record.completedAt).toBe(5);
    expect(record.alarms).toBeUndefined();
    expect(record.priority).toBeUndefined();
  });

  it('never yields an empty title', () => {
    expect(mapReminder({ ...base, title: '' }, 'a').title).toBe('(untitled)');
  });
});

describe('mapReminderList', () => {
  it('is an apple list, visible by default, with its color', () => {
    const list = mapReminderList(
      { allowsModifications: true, colorHex: '#ff0000', id: 'l', title: 'Groceries' },
      'apple-reminders',
    );
    expect(list).toMatchObject({
      accountId: 'apple-reminders',
      colorHex: '#ff0000',
      isVisible: true,
      provider: 'apple',
      title: 'Groceries',
    });
    expect(list.readOnly).toBeUndefined();
  });

  it('marks a list EventKit will not let us write as read-only', () => {
    const list = mapReminderList(
      { allowsModifications: false, id: 'l', title: 'Subscribed' },
      'apple-reminders',
    );
    expect(list.readOnly).toBe(true);
  });
});

describe('toReminderWrite', () => {
  it('drops undefined, keeps null as clear, maps priority, and turns empty strings into clears', () => {
    expect(
      toReminderWrite({
        alarms: null,
        dueTime: '09:00',
        notes: '',
        priority: 'low',
        recurrence: null,
        title: 'x',
        url: undefined,
      }),
    ).toEqual({
      alarms: null,
      dueTime: '09:00',
      notes: null,
      priority: 9,
      recurrence: null,
      title: 'x',
    });
    expect(toReminderWrite({ priority: null })).toEqual({ priority: 0 });
  });
});
