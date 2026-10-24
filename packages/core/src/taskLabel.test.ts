import { describe, expect, it } from 'vite-plus/test';
import {
  dueDayLabel,
  OVERDUE_MARKER,
  overdueLabel,
  priorityMarker,
  REPEAT_MARKER,
  taskChipLabel,
  taskFoldDescription,
  taskFoldLabel,
  taskFoldTitle,
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
    expect(dueDayLabel('2026-09-17', '2026-09-20')).toBe('due Sep 17');
  });
});

describe('taskRepeats', () => {
  it('is true for an expressible or an unsupported repeat rule', () => {
    expect(taskRepeats({})).toBe(false);
    expect(taskRepeats({ recurrence: { freq: 'weekly', interval: 1 } })).toBe(true);
    expect(taskRepeats({ recurrenceUnsupported: true })).toBe(true);
  });
});

describe('taskFoldLabel', () => {
  it('leads with the count, the overdue fold with the warning marker too', () => {
    expect(taskFoldLabel('overdue', 12)).toBe(`${OVERDUE_MARKER} 12 overdue`);
    expect(taskFoldLabel('undated', 11)).toBe('11 no date');
  });

  it('names the list and spells the fold out for screen readers', () => {
    expect(taskFoldTitle('overdue')).toBe('Overdue');
    expect(taskFoldTitle('undated')).toBe('No date');
    expect(taskFoldDescription('overdue', 12)).toBe('12 overdue tasks');
    expect(taskFoldDescription('undated', 2)).toBe('2 tasks with no date');
    expect(taskFoldDescription('undated', 1)).toBe('1 task with no date');
  });
});
