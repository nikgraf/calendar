import {
  Account,
  type AppleCalendarPref,
  type AppleTaskListPref,
  type BirthdayReminderOverrides,
  type BirthdayReminderSettings,
  canonicalBirthdayOverrides,
  type EventNotificationSettings,
  isAppleCalendarAccount,
  isAppleRemindersAccount,
  type ScreenPrivacy,
  type SettingsDocument,
  type SettingsImportSummary,
  type SettingsSection,
  type TimeZoneSettings,
  type ViewPreferences,
} from '@calendar/core';
import { AccountRepo, CalendarRepo, DeviceSettingsRepo, TaskRepo } from '@calendar/db';
import { Clock, Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import {
  readBirthdayReminderOverrides,
  readBirthdayReminderSettings,
  readEventNotificationSettings,
  readTimeZoneSettings,
  readViewPreferences,
  updateBirthdayReminderOverrides,
  writeTimeZoneSettings,
  writeViewPreferences,
} from './deviceSettings.ts';
import {
  flipCalendars,
  flipTaskLists,
  type GooglePendingVisibility,
  matchAppleCalendars,
  matchAppleTaskLists,
  matchGoogleCalendars,
  matchGoogleTaskLists,
  type PendingVisibility,
  readPendingVisibility,
  type VisibilityFlip,
  withPendingVisibilityLock,
  writePendingVisibility,
} from './importedVisibility.ts';
import { LocalNotifications } from './localNotifications.ts';
import {
  planMirrorImport,
  readMirrorLocals,
  readMirrors,
  writeMirrorLocals,
  writeMirrors,
} from './mirrorSettings.ts';
import {
  applyBirthdayReminderSettings,
  applyEventNotificationSettings,
} from './notificationSettings.ts';
import type { NotificationSink } from './notificationSink.ts';
import { PlatformSettings } from './platformSettings.ts';

type PlanServices = AccountRepo | CalendarRepo | DeviceSettingsRepo | PlatformSettings | TaskRepo;
type ImportServices = LocalNotifications | NotificationSink | PlanServices;

interface AccountFlips {
  readonly accountId: string;
  readonly calendars: ReadonlyArray<VisibilityFlip>;
  readonly taskLists: ReadonlyArray<VisibilityFlip>;
}

/** Everything an import would do, computed once; preview reports it, import executes it. */
interface ImportPlan {
  /** The file's per-person entries, joined into what is stored when the import runs. */
  readonly birthdayReminderOverrides?: BirthdayReminderOverrides | undefined;
  readonly birthdayReminders?: BirthdayReminderSettings | undefined;
  readonly eventNotifications?: EventNotificationSettings | undefined;
  readonly flips: ReadonlyArray<AccountFlips>;
  readonly googleAccountsToAdd: ReadonlyArray<string>;
  readonly mirrors?: ReturnType<typeof planMirrorImport> | undefined;
  readonly pending: PendingVisibility;
  readonly screenPrivacy?: ScreenPrivacy | undefined;
  readonly summary: SettingsImportSummary;
  readonly timeZones?: TimeZoneSettings | undefined;
  readonly view?: ViewPreferences | undefined;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Stored entries plus a file's; the file's wins for the same person. */
const joinOverrides = (
  current: BirthdayReminderOverrides,
  incoming: BirthdayReminderOverrides,
): BirthdayReminderOverrides => canonicalBirthdayOverrides([...current, ...incoming]);

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

const planSettingsImport = (
  document: SettingsDocument,
): Effect.Effect<ImportPlan, SqlError, PlanServices> =>
  Effect.gen(function* () {
    const accountRepo = yield* AccountRepo;
    const calendarRepo = yield* CalendarRepo;
    const taskRepo = yield* TaskRepo;
    const platform = yield* PlatformSettings;

    const settingsChanged: Array<SettingsSection> = [];
    const notes: Array<string> = [];

    // Settings sections: written only when present and different, so a
    // re-apply of an unchanged file touches nothing.
    const timeZones =
      document.timeZones && !same(document.timeZones, yield* readTimeZoneSettings)
        ? document.timeZones
        : undefined;
    if (timeZones) {
      settingsChanged.push('timeZones');
    }
    const eventNotifications =
      document.eventNotifications &&
      !same(document.eventNotifications, yield* readEventNotificationSettings)
        ? document.eventNotifications
        : undefined;
    if (eventNotifications) {
      settingsChanged.push('eventNotifications');
    }
    const birthdayReminders =
      document.birthdayReminders &&
      !same(document.birthdayReminders, yield* readBirthdayReminderSettings)
        ? document.birthdayReminders
        : undefined;
    if (birthdayReminders) {
      settingsChanged.push('birthdayReminders');
    }
    // Per-person lead days: the file's entries join (and for the same
    // person replace) the ones here; none is removed. The plan keeps the
    // file's entries, not the joined list: the join is redone against
    // what is stored when the import runs (see updateBirthdayReminderOverrides).
    const incomingOverrides = document.birthdayReminderOverrides;
    let birthdayReminderOverrides: BirthdayReminderOverrides | undefined;
    if (incomingOverrides !== undefined) {
      const current = yield* readBirthdayReminderOverrides;
      if (!same(joinOverrides(current, incomingOverrides), current)) {
        birthdayReminderOverrides = incomingOverrides;
        settingsChanged.push('birthdayReminderOverrides');
      }
    }
    // Only the lane cap is imported; the device-local fields (opening view,
    // sidebar) keep whatever this device chose.
    const currentView = yield* readViewPreferences;
    const view =
      document.view && document.view.allDayLaneCollapsed !== currentView.allDayLaneCollapsed
        ? { ...currentView, allDayLaneCollapsed: document.view.allDayLaneCollapsed }
        : undefined;
    if (view) {
      settingsChanged.push('view');
    }
    // Mirrors: added or updated, never removed; an imported one is off here.
    let mirrors: ReturnType<typeof planMirrorImport> | undefined;
    if (document.mirrors !== undefined && document.mirrors.length > 0) {
      const planned = planMirrorImport(
        yield* readMirrors,
        document.mirrors,
        yield* Clock.currentTimeMillis,
      );
      if (planned.added.length + planned.updated.length > 0) {
        mirrors = planned;
        settingsChanged.push('mirrors');
      }
      for (const issue of planned.skipped) {
        notes.push(`A mirror was not imported: ${issue}`);
      }
    }
    let screenPrivacy: ScreenPrivacy | undefined;
    if (document.desktop?.screenPrivacy !== undefined) {
      const current = yield* platform.read;
      if (current.screenPrivacy === undefined) {
        notes.push('Screen privacy is a desktop setting and was ignored here.');
      } else if (current.screenPrivacy !== document.desktop.screenPrivacy) {
        screenPrivacy = document.desktop.screenPrivacy;
        settingsChanged.push('screenPrivacy');
      }
    }

    // Accounts: the file's per-account section replaces what an earlier
    // import parked for that account; accounts the file does not mention
    // keep theirs.
    const accounts = yield* accountRepo.list();
    const existingPending = yield* readPendingVisibility;
    const google: Record<string, GooglePendingVisibility> = { ...existingPending.google };
    let appleCalendar: ReadonlyArray<AppleCalendarPref> | undefined = existingPending.appleCalendar;
    let appleReminders: ReadonlyArray<AppleTaskListPref> | undefined =
      existingPending.appleReminders;
    const flips: Array<AccountFlips> = [];
    const googleAccountsToAdd: Array<string> = [];
    const appleAccountsPending: Array<SettingsImportSummary['appleAccountsPending'][number]> = [];
    let visibilityChanges = 0;
    let visibilityPending = 0;

    for (const entry of document.accounts ?? []) {
      switch (entry.kind) {
        case 'google': {
          const email = entry.email.toLowerCase();
          const account = accounts.find(
            (candidate) =>
              candidate.provider === 'google' && candidate.email.toLowerCase() === email,
          );
          const prefs = { calendars: entry.calendars ?? [], taskLists: entry.taskLists ?? [] };
          if (!account) {
            if (!googleAccountsToAdd.includes(email)) {
              googleAccountsToAdd.push(email);
            }
            google[email] = prefs;
            visibilityPending += prefs.calendars.length + prefs.taskLists.length;
            break;
          }
          const calendars = matchGoogleCalendars(
            yield* calendarRepo.list(account.id),
            prefs.calendars,
          );
          const taskLists = matchGoogleTaskLists(
            yield* taskRepo.listLists(account.id),
            prefs.taskLists,
          );
          flips.push({
            accountId: account.id,
            calendars: calendars.flips,
            taskLists: taskLists.flips,
          });
          visibilityChanges += calendars.flips.length + taskLists.flips.length;
          google[email] = { calendars: calendars.unmatched, taskLists: taskLists.unmatched };
          const unmatched = calendars.unmatched.length + taskLists.unmatched.length;
          visibilityPending += unmatched;
          if (unmatched > 0) {
            notes.push(
              `${plural(unmatched, 'entry')} for ${account.email} not found here yet — applied once they sync.`,
            );
          }
          break;
        }
        case 'apple-calendar': {
          const prefs = entry.calendars ?? [];
          const account = accounts.find((candidate) => isAppleCalendarAccount(candidate));
          if (!account) {
            appleCalendar = prefs;
            visibilityPending += prefs.length;
            appleAccountsPending.push({ kind: 'apple-calendar', pendingCount: prefs.length });
            break;
          }
          const result = matchAppleCalendars(yield* calendarRepo.list(account.id), prefs);
          flips.push({ accountId: account.id, calendars: result.flips, taskLists: [] });
          visibilityChanges += result.flips.length;
          appleCalendar = result.unmatched;
          visibilityPending += result.unmatched.length;
          if (result.unmatched.length > 0) {
            notes.push(
              `${plural(result.unmatched.length, 'Apple calendar')} not found here yet — applied once they sync.`,
            );
          }
          break;
        }
        case 'apple-reminders': {
          const prefs = entry.taskLists ?? [];
          const account = accounts.find((candidate) => isAppleRemindersAccount(candidate));
          if (!account) {
            appleReminders = prefs;
            visibilityPending += prefs.length;
            appleAccountsPending.push({ kind: 'apple-reminders', pendingCount: prefs.length });
            break;
          }
          const result = matchAppleTaskLists(yield* taskRepo.listLists(account.id), prefs);
          flips.push({ accountId: account.id, calendars: [], taskLists: result.flips });
          visibilityChanges += result.flips.length;
          appleReminders = result.unmatched;
          visibilityPending += result.unmatched.length;
          if (result.unmatched.length > 0) {
            notes.push(
              `${plural(result.unmatched.length, 'Reminders list')} not found here yet — applied once they sync.`,
            );
          }
          break;
        }
      }
    }

    const pending: PendingVisibility = { appleCalendar, appleReminders, google };
    return {
      birthdayReminderOverrides,
      birthdayReminders,
      eventNotifications,
      flips,
      googleAccountsToAdd,
      mirrors,
      pending,
      screenPrivacy,
      summary: {
        appleAccountsPending,
        googleAccountsToAdd,
        notes,
        settingsChanged,
        visibilityChanges,
        visibilityPending,
      },
      timeZones,
      view,
    };
  });

/** What `importSettings` would do with this document, without doing it. */
export const previewSettingsImport = (
  document: SettingsDocument,
): Effect.Effect<SettingsImportSummary, SqlError, PlanServices> =>
  withPendingVisibilityLock(Effect.map(planSettingsImport(document), (plan) => plan.summary));

/**
 * Applies a document. Settings go through the same paths as the settings
 * rpcs (notification toggles prompt and reschedule). A Google account the
 * file lists that is unknown here is created as `reauth_required` with no
 * token — the existing "Sign in again" UI is the checklist, and a sign-in
 * keeps the id so parked preferences apply on the first sync. Apple
 * accounts are never created or connected by an import. Nothing is ever
 * removed. The plan is computed under the pending-visibility lock so a
 * concurrent sync pass cannot drop what it parks.
 */
export const importSettings = (
  document: SettingsDocument,
): Effect.Effect<SettingsImportSummary, SqlError, ImportServices> =>
  withPendingVisibilityLock(
    Effect.gen(function* () {
      const plan = yield* planSettingsImport(document);
      const accountRepo = yield* AccountRepo;
      const platform = yield* PlatformSettings;

      if (plan.timeZones) {
        yield* writeTimeZoneSettings(plan.timeZones);
      }
      if (plan.view) {
        yield* writeViewPreferences(plan.view);
      }
      if (plan.eventNotifications) {
        yield* applyEventNotificationSettings(plan.eventNotifications);
      }
      if (plan.birthdayReminders) {
        yield* applyBirthdayReminderSettings(plan.birthdayReminders);
      }
      const incomingOverrides = plan.birthdayReminderOverrides;
      if (incomingOverrides) {
        yield* updateBirthdayReminderOverrides((current) =>
          joinOverrides(current, incomingOverrides),
        );
        yield* Effect.forkDetach((yield* LocalNotifications).run());
      }
      if (plan.screenPrivacy) {
        yield* platform.apply({ screenPrivacy: plan.screenPrivacy });
      }
      if (plan.mirrors) {
        yield* writeMirrors(plan.mirrors.next);
        // Each new mirror gets an explicit "off" here, so a later edit on
        // this device does not read as "made here" and switch it on.
        const locals = yield* readMirrorLocals;
        yield* writeMirrorLocals({
          ...Object.fromEntries(
            plan.mirrors.added.map((mirror) => [mirror.id, { enabled: false }]),
          ),
          ...locals,
        });
      }

      const now = yield* Clock.currentTimeMillis;
      for (const email of plan.googleAccountsToAdd) {
        const prefs = plan.pending.google?.[email];
        yield* accountRepo.upsert(
          new Account({
            contactsEnabled: false,
            createdAt: now,
            email,
            // Web Crypto: native in Node and Electron, polyfilled from
            // expo-crypto on Hermes (apps/ios/src/polyfills.ts).
            id: crypto.randomUUID(),
            provider: 'google',
            status: 'reauth_required',
            tasksEnabled: (prefs?.taskLists.length ?? 0) > 0,
          }),
        );
      }

      for (const entry of plan.flips) {
        yield* flipCalendars(entry.accountId, entry.calendars);
        yield* flipTaskLists(entry.accountId, entry.taskLists);
      }
      yield* writePendingVisibility(plan.pending);
      return plan.summary;
    }),
  );
