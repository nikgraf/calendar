import {
  type Account,
  type AppleCalendarPref,
  type AppleTaskListPref,
  type GoogleCalendarPref,
  type GoogleTaskListPref,
  isAppleCalendarAccount,
  isAppleRemindersAccount,
  SETTINGS_DOCUMENT_VERSION,
  type SettingsAccount,
  type SettingsDocument,
  withCanonicalZones,
} from '@calendar/core';
import { AccountRepo, CalendarRepo, type DeviceSettingsRepo, TaskRepo } from '@calendar/db';
import { Effect } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import {
  readBirthdayReminderSettings,
  readEventNotificationSettings,
  readTimeZoneSettings,
  readViewPreferences,
} from './deviceSettings.ts';
import { readMirrors } from './mirrorSettings.ts';
import {
  appleCalendarSource,
  type PendingVisibility,
  readPendingVisibility,
} from './importedVisibility.ts';
import { PlatformSettings } from './platformSettings.ts';

const googleAccount = (
  account: Account,
  calendars: ReadonlyArray<GoogleCalendarPref>,
  taskLists: ReadonlyArray<GoogleTaskListPref>,
  pending: PendingVisibility['google'],
): SettingsAccount => {
  const parked = pending?.[account.email.toLowerCase()];
  const knownCalendars = new Set(calendars.map((calendar) => calendar.id));
  const knownLists = new Set(taskLists.map((list) => list.id));
  return {
    calendars: [
      ...calendars,
      ...(parked?.calendars ?? []).filter((pref) => !knownCalendars.has(pref.id)),
    ],
    email: account.email,
    kind: 'google',
    taskLists: [
      ...taskLists,
      ...(parked?.taskLists ?? []).filter((pref) => !knownLists.has(pref.id)),
    ],
  };
};

const appleCalendarAccount = (
  calendars: ReadonlyArray<AppleCalendarPref>,
  parked: ReadonlyArray<AppleCalendarPref>,
): SettingsAccount => {
  const known = new Set(calendars.map((pref) => `${pref.source}\n${pref.title}`));
  return {
    calendars: [
      ...calendars,
      ...parked.filter((pref) => !known.has(`${pref.source}\n${pref.title}`)),
    ],
    kind: 'apple-calendar',
  };
};

const appleRemindersAccount = (
  taskLists: ReadonlyArray<AppleTaskListPref>,
  parked: ReadonlyArray<AppleTaskListPref>,
): SettingsAccount => {
  const known = new Set(taskLists.map((pref) => pref.title));
  return {
    kind: 'apple-reminders',
    taskLists: [...taskLists, ...parked.filter((pref) => !known.has(pref.title))],
  };
};

/**
 * The document as this device would export it: device settings (zones in
 * their current IANA spelling), the host's own settings when it has any,
 * and every account with its calendar/list visibility. Preferences an
 * earlier import parked for rows that have not synced yet are merged back
 * in — the desktop's write-back runs right after an import, and without
 * this it would erase them from the file (a whole not-yet-connected Apple
 * account included). Ordering is deterministic (accounts by creation,
 * rows by title) so an unchanged state produces identical text.
 */
export const buildSettingsDocument: Effect.Effect<
  SettingsDocument,
  SqlError,
  AccountRepo | CalendarRepo | DeviceSettingsRepo | PlatformSettings | TaskRepo
> = Effect.gen(function* () {
  const accountRepo = yield* AccountRepo;
  const calendarRepo = yield* CalendarRepo;
  const taskRepo = yield* TaskRepo;
  const platform = yield* PlatformSettings;

  const pending = yield* readPendingVisibility;
  const accounts: Array<SettingsAccount> = [];
  let sawAppleCalendar = false;
  let sawAppleReminders = false;
  const seenGoogle = new Set<string>();
  for (const account of yield* accountRepo.list()) {
    if (isAppleCalendarAccount(account)) {
      sawAppleCalendar = true;
      const calendars = (yield* calendarRepo.list(account.id)).map((calendar) => ({
        source: appleCalendarSource(calendar),
        title: calendar.summary,
        visible: calendar.isVisible,
      }));
      accounts.push(appleCalendarAccount(calendars, pending.appleCalendar ?? []));
    } else if (isAppleRemindersAccount(account)) {
      sawAppleReminders = true;
      const lists = (yield* taskRepo.listLists(account.id)).map((list) => ({
        title: list.title,
        visible: list.isVisible,
      }));
      accounts.push(appleRemindersAccount(lists, pending.appleReminders ?? []));
    } else {
      seenGoogle.add(account.email.toLowerCase());
      const calendars = (yield* calendarRepo.list(account.id)).map((calendar) => ({
        id: calendar.id,
        title: calendar.summary,
        visible: calendar.isVisible,
      }));
      const lists = (yield* taskRepo.listLists(account.id)).map((list) => ({
        id: list.id,
        title: list.title,
        visible: list.isVisible,
      }));
      accounts.push(googleAccount(account, calendars, lists, pending.google));
    }
  }
  for (const [email, entry] of Object.entries(pending.google ?? {})) {
    if (!seenGoogle.has(email)) {
      accounts.push({
        calendars: entry.calendars,
        email,
        kind: 'google',
        taskLists: entry.taskLists,
      });
    }
  }
  if (!sawAppleCalendar && pending.appleCalendar?.length) {
    accounts.push({ calendars: pending.appleCalendar, kind: 'apple-calendar' });
  }
  if (!sawAppleReminders && pending.appleReminders?.length) {
    accounts.push({ kind: 'apple-reminders', taskLists: pending.appleReminders });
  }

  const desktop = yield* platform.read;
  return withCanonicalZones({
    accounts,
    birthdayReminders: yield* readBirthdayReminderSettings,
    ...(desktop.screenPrivacy === undefined
      ? {}
      : { desktop: { screenPrivacy: desktop.screenPrivacy } }),
    eventNotifications: yield* readEventNotificationSettings,
    mirrors: yield* readMirrors,
    timeZones: yield* readTimeZoneSettings,
    version: SETTINGS_DOCUMENT_VERSION,
    view: yield* readViewPreferences,
  });
});
