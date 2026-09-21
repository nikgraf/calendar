import { describe, expect, it } from 'vitest';
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
    expect(loss).toEqual({ alarms: 2, dueTime: true, priority: true, recurrence: true, url: true });
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
});
