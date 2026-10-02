import {
  Account,
  APPLE_CALENDAR_ACCOUNT_ID,
  APPLE_REMINDERS_ACCOUNT_ID,
  CalendarInfo,
  type DesktopSettings,
  TaskListInfo,
} from '@calendar/core';
import { AccountRepo, CalendarRepo, reposLayer, runMigrations, TaskRepo } from '@calendar/db';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { LocalNotifications } from '../localNotifications.ts';
import { NotificationSink, noopNotificationSink } from '../notificationSink.ts';
import { PlatformSettings } from '../platformSettings.ts';

/**
 * Test scaffolding for the settings export/import suites: an in-memory
 * database with every repo, inert notification services, and a platform
 * settings fake that records what an import applied.
 */
export const makeSettingsTestLayer = (
  options: { readonly screenPrivacy?: 'hidden' | 'visible' } = {},
) => {
  const applied: Array<DesktopSettings> = [];
  let current: DesktopSettings = options.screenPrivacy
    ? { screenPrivacy: options.screenPrivacy }
    : {};
  const platform: Layer.Layer<PlatformSettings> = Layer.succeed(PlatformSettings, {
    apply: (section) =>
      Effect.sync(() => {
        applied.push(section);
        current = { ...current, ...section };
      }),
    read: Effect.sync(() => current),
  });
  const layer = Layer.mergeAll(
    reposLayer.pipe(
      Layer.provideMerge(Layer.effectDiscard(runMigrations)),
      Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
      Layer.provideMerge(reactivityLayer),
    ),
    platform,
    Layer.succeed(NotificationSink, noopNotificationSink),
    Layer.succeed(LocalNotifications, { run: () => Effect.void, start: () => Effect.void }),
  );
  return { applied, layer };
};

export const googleAccount = (
  id: string,
  email: string,
  status: Account['status'] = 'ok',
): Account =>
  new Account({
    contactsEnabled: false,
    createdAt: 1,
    email,
    id,
    provider: 'google',
    status,
    tasksEnabled: true,
  });

export const appleCalendarAccount = (): Account =>
  new Account({
    contactsEnabled: false,
    createdAt: 2,
    email: '',
    id: APPLE_CALENDAR_ACCOUNT_ID,
    provider: 'apple',
    status: 'ok',
    tasksEnabled: false,
  });

export const appleRemindersAccount = (): Account =>
  new Account({
    contactsEnabled: false,
    createdAt: 3,
    email: '',
    id: APPLE_REMINDERS_ACCOUNT_ID,
    provider: 'apple',
    status: 'ok',
    tasksEnabled: true,
  });

export const calendar = (
  accountId: string,
  id: string,
  summary: string,
  options: { readonly isVisible?: boolean; readonly sourceTitle?: string } = {},
): CalendarInfo =>
  new CalendarInfo({
    accessRole: 'owner',
    accountId,
    colorHex: '#000000',
    id,
    isPrimary: false,
    isVisible: options.isVisible ?? true,
    provider: accountId === APPLE_CALENDAR_ACCOUNT_ID ? 'apple' : 'google',
    ...(options.sourceTitle === undefined ? {} : { sourceTitle: options.sourceTitle }),
    summary,
    timeZone: 'UTC',
  });

export const taskList = (
  accountId: string,
  id: string,
  title: string,
  isVisible = true,
): TaskListInfo =>
  new TaskListInfo({
    accountId,
    id,
    isVisible,
    provider: accountId === APPLE_REMINDERS_ACCOUNT_ID ? 'apple' : 'google',
    title,
  });

/** Seeds accounts, calendars and lists in one go. */
export const seed = (rows: {
  readonly accounts?: ReadonlyArray<Account>;
  readonly calendars?: ReadonlyArray<CalendarInfo>;
  readonly taskLists?: ReadonlyArray<TaskListInfo>;
}) =>
  Effect.gen(function* () {
    const accountRepo = yield* AccountRepo;
    const calendarRepo = yield* CalendarRepo;
    const taskRepo = yield* TaskRepo;
    for (const account of rows.accounts ?? []) {
      yield* accountRepo.upsert(account);
    }
    if (rows.calendars?.length) {
      yield* calendarRepo.upsertMany(rows.calendars);
    }
    if (rows.taskLists?.length) {
      yield* taskRepo.upsertLists(rows.taskLists, 1);
    }
  });
