import { describe, expect, it } from 'vite-plus/test';
import {
  DEFAULT_EVENT_NOTIFICATION_SETTINGS,
  dismissesWhenOver,
  mergeEventNotificationSettings,
} from './settings.ts';

describe('dismissesWhenOver', () => {
  it('is on unless switched off, also when the field is missing', () => {
    expect(dismissesWhenOver({})).toBe(true);
    expect(dismissesWhenOver({ dismissWhenOver: true })).toBe(true);
    expect(dismissesWhenOver({ dismissWhenOver: false })).toBe(false);
    expect(dismissesWhenOver(DEFAULT_EVENT_NOTIFICATION_SETTINGS)).toBe(true);
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
