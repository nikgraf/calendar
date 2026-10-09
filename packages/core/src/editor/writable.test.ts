import { describe, expect, it } from 'vite-plus/test';
import { isCalendarWritable, isTaskListWritable } from './writable.ts';

describe('isCalendarWritable', () => {
  it('accepts the two roles a provider lets us write with', () => {
    expect(isCalendarWritable({ accessRole: 'owner' })).toBe(true);
    expect(isCalendarWritable({ accessRole: 'writer' })).toBe(true);
  });

  it('rejects read-only roles and an unknown calendar', () => {
    expect(isCalendarWritable({ accessRole: 'reader' })).toBe(false);
    expect(isCalendarWritable({ accessRole: 'freeBusyReader' })).toBe(false);
    expect(isCalendarWritable(undefined)).toBe(false);
    expect(isCalendarWritable(null)).toBe(false);
  });
});

describe('isTaskListWritable', () => {
  it('treats a list without the flag as writable (Google lists never carry it)', () => {
    expect(isTaskListWritable({})).toBe(true);
    expect(isTaskListWritable({ readOnly: false })).toBe(true);
  });

  it('rejects a read-only Reminders list and an unknown list', () => {
    expect(isTaskListWritable({ readOnly: true })).toBe(false);
    expect(isTaskListWritable(undefined)).toBe(false);
    expect(isTaskListWritable(null)).toBe(false);
  });
});
