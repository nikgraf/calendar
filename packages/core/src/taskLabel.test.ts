import { describe, expect, it } from 'vitest';
import { priorityMarker, taskChipLabel } from './taskLabel.ts';

describe('taskChipLabel', () => {
  it('prefixes time and priority marker in that order', () => {
    expect(taskChipLabel({ title: 'Call mom' })).toBe('Call mom');
    expect(taskChipLabel({ dueTime: '14:00', title: 'Call mom' })).toBe('14:00 Call mom');
    expect(taskChipLabel({ priority: 'high', title: 'Taxes' })).toBe('!!! Taxes');
    expect(taskChipLabel({ dueTime: '09:30', priority: 'low', title: 'Water' })).toBe(
      '09:30 ! Water',
    );
  });

  it('maps priority buckets to the Reminders markers', () => {
    expect(priorityMarker(undefined)).toBe('');
    expect(priorityMarker('low')).toBe('!');
    expect(priorityMarker('medium')).toBe('!!');
    expect(priorityMarker('high')).toBe('!!!');
  });
});
