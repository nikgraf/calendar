import { describe, expect, it } from 'vite-plus/test';
import {
  DEFAULT_EVENT_NOTIFICATION_SETTINGS,
  DEFAULT_TASK_NOTIFICATION_SETTINGS,
  dismissesWhenDone,
  dismissesWhenOver,
  mergeEventNotificationSettings,
  mergeTaskNotificationSettings,
  sameEventNotificationSettings,
  sameTaskNotificationSettings,
} from './settings.ts';

describe('dismissesWhenOver', () => {
  it('is on unless switched off, also when the field is missing', () => {
    expect(dismissesWhenOver({})).toBe(true);
    expect(dismissesWhenOver({ dismissWhenOver: true })).toBe(true);
    expect(dismissesWhenOver({ dismissWhenOver: false })).toBe(false);
    expect(dismissesWhenOver(DEFAULT_EVENT_NOTIFICATION_SETTINGS)).toBe(true);
  });
});

describe('sameEventNotificationSettings', () => {
  it('compares what the settings do, an "on" spelled out or left out alike', () => {
    const base = { enabled: true, includeAppleCalendar: false };
    expect(sameEventNotificationSettings(base, { ...base, dismissWhenOver: true })).toBe(true);
    expect(sameEventNotificationSettings(base, { ...base, dismissWhenOver: false })).toBe(false);
    expect(sameEventNotificationSettings(base, { ...base, enabled: false })).toBe(false);
  });
});

describe('mergeEventNotificationSettings', () => {
  const off = { dismissWhenOver: false, enabled: true, includeAppleCalendar: false };

  it('keeps the current value of a field the incoming settings leave out', () => {
    expect(
      mergeEventNotificationSettings(off, { enabled: false, includeAppleCalendar: true }),
    ).toEqual({ dismissWhenOver: false, enabled: false, includeAppleCalendar: true });
    expect(
      mergeEventNotificationSettings(
        { enabled: true, includeAppleCalendar: false },
        { enabled: true, includeAppleCalendar: false },
      ),
    ).toEqual(DEFAULT_EVENT_NOTIFICATION_SETTINGS);
  });

  it('takes every field the incoming settings name', () => {
    expect(
      mergeEventNotificationSettings(off, {
        dismissWhenOver: true,
        enabled: false,
        includeAppleCalendar: true,
      }),
    ).toEqual({ dismissWhenOver: true, enabled: false, includeAppleCalendar: true });
  });
});

describe('dismissesWhenDone', () => {
  it('is on per provider unless that switch is off, also when the field is missing', () => {
    expect(dismissesWhenDone({}, 'google')).toBe(true);
    expect(dismissesWhenDone({}, 'apple')).toBe(true);
    expect(dismissesWhenDone({ dismissTasksWhenDone: false }, 'google')).toBe(false);
    expect(dismissesWhenDone({ dismissTasksWhenDone: false }, 'apple')).toBe(true);
    expect(dismissesWhenDone({ dismissRemindersWhenDone: false }, 'apple')).toBe(false);
    expect(dismissesWhenDone({ dismissRemindersWhenDone: false }, 'google')).toBe(true);
    expect(dismissesWhenDone(DEFAULT_TASK_NOTIFICATION_SETTINGS, 'google')).toBe(true);
  });
});

describe('sameTaskNotificationSettings', () => {
  it('compares what the settings do, an "on" spelled out or left out alike', () => {
    const base = { enabled: true, includeAppleReminders: true, time: '09:00' };
    expect(sameTaskNotificationSettings(base, { ...base, dismissTasksWhenDone: true })).toBe(true);
    expect(sameTaskNotificationSettings(base, { ...base, dismissRemindersWhenDone: true })).toBe(
      true,
    );
    expect(sameTaskNotificationSettings(base, { ...base, dismissTasksWhenDone: false })).toBe(
      false,
    );
    expect(sameTaskNotificationSettings(base, { ...base, dismissRemindersWhenDone: false })).toBe(
      false,
    );
    expect(sameTaskNotificationSettings(base, { ...base, time: '08:00' })).toBe(false);
    expect(sameTaskNotificationSettings(base, { ...base, includeAppleReminders: false })).toBe(
      false,
    );
  });
});

describe('mergeTaskNotificationSettings', () => {
  const current = {
    dismissRemindersWhenDone: false,
    enabled: true,
    includeAppleReminders: true,
    time: '09:00',
  };

  it('keeps each switch the incoming settings leave out, and takes the rest', () => {
    expect(
      mergeTaskNotificationSettings(current, {
        enabled: false,
        includeAppleReminders: false,
        time: '18:00',
      }),
    ).toEqual({
      dismissRemindersWhenDone: false,
      enabled: false,
      includeAppleReminders: false,
      time: '18:00',
    });
    expect(
      mergeTaskNotificationSettings(current, { ...current, dismissTasksWhenDone: false }),
    ).toEqual({ ...current, dismissTasksWhenDone: false });
    expect(
      mergeTaskNotificationSettings(
        DEFAULT_TASK_NOTIFICATION_SETTINGS,
        DEFAULT_TASK_NOTIFICATION_SETTINGS,
      ),
    ).toEqual(DEFAULT_TASK_NOTIFICATION_SETTINGS);
  });

  it('takes a switch the incoming settings name over the current one', () => {
    expect(
      mergeTaskNotificationSettings(current, { ...current, dismissRemindersWhenDone: true }),
    ).toEqual({ ...current, dismissRemindersWhenDone: true });
  });
});
