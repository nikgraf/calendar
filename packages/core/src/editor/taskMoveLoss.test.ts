import { describe, expect, it } from 'vite-plus/test';
import { isTaskMoveLossy, taskMoveLoss, taskMoveLossSummary } from './taskMoveLoss.ts';

const reminder = {
  alarms: [-15, -1440],
  dueTime: '09:00',
  priority: 'high',
  recurrence: { freq: 'weekly', interval: 1 },
  url: 'https://example.com',
} as const;

describe('taskMoveLoss', () => {
  it('lists everything Google Tasks cannot hold when a reminder leaves Reminders', () => {
    const loss = taskMoveLoss(reminder, {
      sameAccount: false,
      source: 'apple',
      target: 'google',
    });
    expect(loss).toEqual({
      alarms: 2,
      dueTime: true,
      leavesParent: false,
      priority: true,
      recurrence: true,
      subtasksUnnested: 0,
      url: true,
    });
    expect(isTaskMoveLossy(loss)).toBe(true);
    expect(taskMoveLossSummary(loss)).toBe(
      'Moving this task to Google Tasks drops the due time, 2 alerts, the priority, the repeat rule and the URL.',
    );
  });

  it('counts a repeat rule the app cannot express as a repeat rule', () => {
    const loss = taskMoveLoss(
      { recurrenceUnsupported: true },
      { sameAccount: false, source: 'apple', target: 'google' },
    );
    expect(loss.recurrence).toBe(true);
    expect(taskMoveLossSummary(loss)).toBe(
      'Moving this task to Google Tasks drops the repeat rule.',
    );
  });

  it('loses nothing for a plain reminder', () => {
    const loss = taskMoveLoss({}, { sameAccount: false, source: 'apple', target: 'google' });
    expect(isTaskMoveLossy(loss)).toBe(false);
    expect(taskMoveLossSummary(loss)).toBeNull();
  });

  it('loses nothing toward Reminders, between Reminders lists, or between Google lists', () => {
    for (const route of [
      { sameAccount: false, source: 'google', target: 'apple' },
      { sameAccount: true, source: 'apple', target: 'apple' },
      { sameAccount: true, source: 'google', target: 'google' },
      { sameAccount: false, source: 'google', target: 'google' },
    ] as const) {
      expect(isTaskMoveLossy(taskMoveLoss(reminder, route))).toBe(false);
    }
  });

  it('says a subtask leaves its parent, on any route out of Google', () => {
    for (const route of [
      { sameAccount: true, source: 'google', target: 'google' },
      { sameAccount: false, source: 'google', target: 'google' },
      { sameAccount: false, source: 'google', target: 'apple' },
    ] as const) {
      const loss = taskMoveLoss({ parentId: 'parent' }, route);
      expect(loss.leavesParent).toBe(true);
      expect(taskMoveLossSummary(loss)).toBe(
        'It is a subtask: in the new list it becomes a task of its own.',
      );
    }
  });

  it('counts subtasks that cannot stay nested: only Reminders flattens them', () => {
    const toReminders = taskMoveLoss(
      {},
      { sameAccount: false, source: 'google', target: 'apple' },
      3,
    );
    expect(toReminders.subtasksUnnested).toBe(3);
    expect(taskMoveLossSummary(toReminders)).toBe(
      'Its 3 subtasks come along as reminders of their own.',
    );
    expect(
      taskMoveLossSummary(
        taskMoveLoss({}, { sameAccount: false, source: 'google', target: 'apple' }, 1),
      ),
    ).toBe('Its subtask comes along as a reminder of its own.');
    for (const route of [
      { sameAccount: true, source: 'google', target: 'google' },
      { sameAccount: false, source: 'google', target: 'google' },
    ] as const) {
      expect(isTaskMoveLossy(taskMoveLoss({}, route, 3))).toBe(false);
    }
  });
});
