import { DeviceSettingsRepo } from '@calendar/db';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';
import { writeBirthdayReminderOverrides, writeTimeZoneSettings } from './deviceSettings.ts';
import { IMPORTED_VISIBILITY_KEY } from './importedVisibility.ts';
import { buildSettingsDocument } from './settingsExport.ts';
import {
  appleCalendarAccount,
  appleRemindersAccount,
  calendar,
  googleAccount,
  makeSettingsTestLayer,
  seed,
  taskList,
} from './testing/settingsTesting.ts';

describe('buildSettingsDocument', () => {
  it.effect('exports device settings, the host section and every account kind', () => {
    const { layer } = makeSettingsTestLayer({ screenPrivacy: 'visible' });
    return Effect.gen(function* () {
      yield* seed({
        accounts: [
          googleAccount('acc-1', 'Nik@Example.com'),
          appleCalendarAccount(),
          appleRemindersAccount(),
        ],
        calendars: [
          calendar('acc-1', 'work', 'Work', { isVisible: false }),
          calendar('acc-1', 'nik@example.com', 'Nik'),
          calendar('apple-calendar', 'ek-home', 'Home', { sourceTitle: 'iCloud' }),
          calendar('apple-calendar', 'ek-local', 'Local', { isVisible: false }),
        ],
        taskLists: [
          taskList('acc-1', 'list-1', 'Inbox'),
          taskList('apple-reminders', 'ek-groceries', 'Groceries', false),
        ],
      });
      yield* writeTimeZoneSettings({ primary: 'Asia/Calcutta', zones: ['Asia/Calcutta', 'UTC'] });
      yield* writeBirthdayReminderOverrides([
        { day: 4, displayName: 'Alice', leadDays: [14], month: 3 },
      ]);
      const document = yield* buildSettingsDocument;
      expect(document.version).toBe(1);
      expect(document.birthdayReminderOverrides).toEqual([
        { day: 4, displayName: 'Alice', leadDays: [14], month: 3 },
      ]);
      expect(document.desktop).toEqual({ screenPrivacy: 'visible' });
      expect(document.timeZones).toEqual({
        primary: 'Asia/Kolkata',
        zones: ['Asia/Kolkata', 'UTC'],
      });
      expect(document.eventNotifications).toEqual({ enabled: true, includeAppleCalendar: false });
      expect(document.view).toEqual({ allDayLaneCollapsed: false });
      expect(document.accounts).toEqual([
        {
          calendars: [
            { id: 'nik@example.com', title: 'Nik', visible: true },
            { id: 'work', title: 'Work', visible: false },
          ],
          email: 'Nik@Example.com',
          kind: 'google',
          taskLists: [{ id: 'list-1', title: 'Inbox', visible: true }],
        },
        {
          calendars: [
            { source: 'iCloud', title: 'Home', visible: true },
            { source: 'On My Mac', title: 'Local', visible: false },
          ],
          kind: 'apple-calendar',
        },
        { kind: 'apple-reminders', taskLists: [{ title: 'Groceries', visible: false }] },
      ]);
      expect(JSON.stringify(document)).not.toMatch(/token/i);
    }).pipe(Effect.provide(layer));
  });

  it.effect('omits the host section on a host without one', () => {
    const { layer } = makeSettingsTestLayer();
    return Effect.gen(function* () {
      const document = yield* buildSettingsDocument;
      expect(document.desktop).toBeUndefined();
      expect(document.accounts).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect('merges parked preferences back in, including accounts that do not exist yet', () => {
    const { layer } = makeSettingsTestLayer();
    return Effect.gen(function* () {
      yield* seed({
        accounts: [googleAccount('acc-1', 'nik@example.com')],
        calendars: [calendar('acc-1', 'work', 'Work')],
      });
      yield* (yield* DeviceSettingsRepo).set(IMPORTED_VISIBILITY_KEY, {
        appleCalendar: [{ source: 'iCloud', title: 'Home', visible: false }],
        google: {
          'nik@example.com': {
            calendars: [
              { id: 'work', title: 'Stale title', visible: false },
              { id: 'shared', title: 'Shared', visible: false },
            ],
            taskLists: [],
          },
          'other@example.com': {
            calendars: [{ id: 'x', title: 'X', visible: true }],
            taskLists: [],
          },
        },
      });
      const document = yield* buildSettingsDocument;
      expect(document.accounts).toEqual([
        {
          calendars: [
            { id: 'work', title: 'Work', visible: true },
            { id: 'shared', title: 'Shared', visible: false },
          ],
          email: 'nik@example.com',
          kind: 'google',
          taskLists: [],
        },
        {
          calendars: [{ id: 'x', title: 'X', visible: true }],
          email: 'other@example.com',
          kind: 'google',
          taskLists: [],
        },
        {
          calendars: [{ source: 'iCloud', title: 'Home', visible: false }],
          kind: 'apple-calendar',
        },
      ]);
    }).pipe(Effect.provide(layer));
  });
});
