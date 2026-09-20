import { describe, expect, it } from 'vitest';
import {
  OVERDUE_MARKER,
  overdueLabel,
  priorityMarker,
  REPEAT_MARKER,
  taskChipLabel,
  taskRepeats,
} from './taskLabel.ts';

describe('taskChipLabel', () => {
  it('prefixes time and priority marker in that order', () => {
    expect(taskChipLabel({ title: 'Call mom' })).toBe('Call mom');
    expect(taskChipLabel({ dueTime: '14:00', title: 'Call mom' })).toBe('14:00 Call mom');
    expect(taskChipLabel({ priority: 'high', title: 'Taxes' })).toBe('!!! Taxes');
    expect(taskChipLabel({ dueTime: '09:30', priority: 'low', title: 'Water' })).toBe(
      '09:30 ! Water',
    );
  });

  it('leads an overdue chip with the warning marker and drops the stale time', () => {
    expect(
      taskChipLabel({ dueTime: '14:00', priority: 'high', title: 'Taxes' }, { overdue: true }),
    ).toBe(`${OVERDUE_MARKER} !!! Taxes`);
  });

  it('ends a repeating reminder with the repeat marker', () => {
    expect(taskChipLabel({ dueTime: '14:00', title: 'Call mom' }, { repeats: true })).toBe(
      `14:00 Call mom ${REPEAT_MARKER}`,
    );
    expect(taskChipLabel({ title: 'Taxes' }, { overdue: true, repeats: true })).toBe(
      `${OVERDUE_MARKER} Taxes ${REPEAT_MARKER}`,
    );
  });

  it('maps priority buckets to the Reminders markers', () => {
    expect(priorityMarker(undefined)).toBe('');
    expect(priorityMarker('low')).toBe('!');
    expect(priorityMarker('medium')).toBe('!!');
    expect(priorityMarker('high')).toBe('!!!');
  });
});

describe('overdueLabel', () => {
  it('names the due day, adding the year only when it differs', () => {
    expect(overdueLabel({ dueDate: '2026-09-17' }, '2026-09-20')).toBe('Overdue · due Sep 17');
    expect(overdueLabel({ dueDate: '2025-12-30' }, '2026-01-02')).toBe(
      'Overdue · due Dec 30, 2025',
    );
    expect(overdueLabel({}, '2026-09-20')).toBe('Overdue');
  });
});

describe('taskRepeats', () => {
  it('is true for an expressible or an unsupported repeat rule', () => {
    expect(taskRepeats({})).toBe(false);
    expect(taskRepeats({ recurrence: { freq: 'weekly', interval: 1 } })).toBe(true);
    expect(taskRepeats({ recurrenceUnsupported: true })).toBe(true);
  });
});
