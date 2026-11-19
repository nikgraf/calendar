import { describe, expect, it } from 'vite-plus/test';
import { REMINDER_ALARM_OPTIONS, reminderAlarmOptions } from './taskEditorModel.ts';

describe('reminderAlarmOptions', () => {
  it('offers the presets, with a reminder’s own alert in its place by time where they lack it', () => {
    expect(reminderAlarmOptions(undefined)).toBe(REMINDER_ALARM_OPTIONS);
    expect(reminderAlarmOptions(-15)).toBe(REMINDER_ALARM_OPTIONS);
    expect(reminderAlarmOptions(-10).map((option) => option.label)).toEqual([
      'None',
      'At time',
      '5 min before',
      '10 minutes before',
      '15 min before',
      '1 hour before',
      '1 day before',
    ]);
    expect(reminderAlarmOptions(-2880).at(-1)).toEqual({ label: '2 days before', value: -2880 });
    // An alert after the due time (Reminders.app can set one) comes before "At time".
    expect(reminderAlarmOptions(30)[1]).toEqual({ label: '30 minutes after', value: 30 });
  });
});
