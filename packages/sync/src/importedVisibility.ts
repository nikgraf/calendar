import {
  type Account,
  APPLE_DEFAULT_SOURCE,
  AppleCalendarPref,
  AppleTaskListPref,
  type CalendarInfo,
  GoogleCalendarPref,
  GoogleTaskListPref,
  isAppleCalendarAccount,
  isAppleRemindersAccount,
  type TaskListInfo,
} from '@calendar/core';
import { CalendarRepo, DeviceSettingsRepo, TaskRepo } from '@calendar/db';
import { Effect, Schema, Semaphore } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';

/**
 * Visibility preferences an import could not apply yet: the calendar or
 * list is not in the database (the Google account has not been signed in,
 * Apple is not connected, or the first sync has not run). They wait in a
 * device_settings bookkeeping row and are applied — and dropped — as the
 * rows arrive after each calendar/list sync.
 */
export const IMPORTED_VISIBILITY_KEY = 'importedVisibility';

export const GooglePendingVisibility = Schema.Struct({
  calendars: Schema.Array(GoogleCalendarPref),
  taskLists: Schema.Array(GoogleTaskListPref),
});
export type GooglePendingVisibility = typeof GooglePendingVisibility.Type;

export const PendingVisibility = Schema.Struct({
  appleCalendar: Schema.optional(Schema.Array(AppleCalendarPref)),
  appleReminders: Schema.optional(Schema.Array(AppleTaskListPref)),
  /** Keyed by lowercased email. */
  google: Schema.optional(Schema.Record(Schema.String, GooglePendingVisibility)),
});
export type PendingVisibility = typeof PendingVisibility.Type;

const decodePending = Schema.decodeUnknownEffect(PendingVisibility);

/** The parked preferences, or nothing when the row is missing or no longer decodes. */
export const readPendingVisibility: Effect.Effect<PendingVisibility, SqlError, DeviceSettingsRepo> =
  Effect.gen(function* () {
    const raw = yield* (yield* DeviceSettingsRepo).get(IMPORTED_VISIBILITY_KEY);
    if (raw === null) {
      return {};
    }
    return yield* decodePending(raw).pipe(Effect.orElseSucceed((): PendingVisibility => ({})));
  });

/** Drops empty sections so a fully applied import leaves nothing behind. */
export const compactPendingVisibility = (pending: PendingVisibility): PendingVisibility => {
  const google = Object.fromEntries(
    Object.entries(pending.google ?? {}).filter(
      ([, entry]) => entry.calendars.length > 0 || entry.taskLists.length > 0,
    ),
  );
  return {
    ...(pending.appleCalendar?.length ? { appleCalendar: pending.appleCalendar } : {}),
    ...(pending.appleReminders?.length ? { appleReminders: pending.appleReminders } : {}),
    ...(Object.keys(google).length > 0 ? { google } : {}),
  };
};

export const countPendingVisibility = (pending: PendingVisibility): number =>
  (pending.appleCalendar?.length ?? 0) +
  (pending.appleReminders?.length ?? 0) +
  Object.values(pending.google ?? {}).reduce(
    (sum, entry) => sum + entry.calendars.length + entry.taskLists.length,
    0,
  );

/** Stores the compacted row; an empty one is stored as null, which reads back as nothing. */
export const writePendingVisibility = (
  pending: PendingVisibility,
): Effect.Effect<void, SqlError, DeviceSettingsRepo> =>
  Effect.gen(function* () {
    const repo = yield* DeviceSettingsRepo;
    const compact = compactPendingVisibility(pending);
    yield* repo.set(
      IMPORTED_VISIBILITY_KEY,
      countPendingVisibility(compact) === 0 ? null : compact,
    );
  });

/**
 * One lock around every read-modify-write of the row: a sync pass that
 * read it before an import and wrote after would otherwise drop what the
 * import just parked.
 */
const pendingLock = Semaphore.makeUnsafe(1);
export const withPendingVisibilityLock = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => pendingLock.withPermits(1)(effect);

export const appleCalendarSource = (calendar: CalendarInfo): string =>
  calendar.sourceTitle ?? APPLE_DEFAULT_SOURCE;

export interface VisibilityFlip {
  readonly id: string;
  readonly visible: boolean;
}

export interface VisibilityMatch<Pref> {
  /** Rows whose visibility differs from the preference. */
  readonly flips: ReadonlyArray<VisibilityFlip>;
  /** Preferences that picked no row. */
  readonly unmatched: ReadonlyArray<Pref>;
}

/** Pure: which rows `prefs` would flip, and which prefs pick no row. */
const matchPrefs = <
  Row extends { readonly id: string; readonly isVisible: boolean },
  Pref extends { readonly visible: boolean },
>(
  rows: ReadonlyArray<Row>,
  prefs: ReadonlyArray<Pref>,
  match: (row: Row, pref: Pref) => boolean,
): VisibilityMatch<Pref> => {
  const flips: Array<VisibilityFlip> = [];
  const unmatched: Array<Pref> = [];
  for (const pref of prefs) {
    const targets = rows.filter((row) => match(row, pref));
    if (targets.length === 0) {
      unmatched.push(pref);
      continue;
    }
    for (const row of targets) {
      if (row.isVisible !== pref.visible) {
        flips.push({ id: row.id, visible: pref.visible });
      }
    }
  }
  return { flips, unmatched };
};

export const matchGoogleCalendars = (
  calendars: ReadonlyArray<CalendarInfo>,
  prefs: ReadonlyArray<GoogleCalendarPref>,
): VisibilityMatch<GoogleCalendarPref> =>
  matchPrefs(calendars, prefs, (calendar, pref) => calendar.id === pref.id);

export const matchGoogleTaskLists = (
  lists: ReadonlyArray<TaskListInfo>,
  prefs: ReadonlyArray<GoogleTaskListPref>,
): VisibilityMatch<GoogleTaskListPref> =>
  matchPrefs(lists, prefs, (list, pref) => list.id === pref.id);

/** Apple calendars have per-device ids; source title plus calendar title is the portable key. */
export const matchAppleCalendars = (
  calendars: ReadonlyArray<CalendarInfo>,
  prefs: ReadonlyArray<AppleCalendarPref>,
): VisibilityMatch<AppleCalendarPref> =>
  matchPrefs(
    calendars,
    prefs,
    (calendar, pref) =>
      appleCalendarSource(calendar) === pref.source && calendar.summary === pref.title,
  );

export const matchAppleTaskLists = (
  lists: ReadonlyArray<TaskListInfo>,
  prefs: ReadonlyArray<AppleTaskListPref>,
): VisibilityMatch<AppleTaskListPref> =>
  matchPrefs(lists, prefs, (list, pref) => list.title === pref.title);

/** setVisible also invalidates the event views, which is what repaints an Apple calendar's read-through events. */
export const flipCalendars = (
  accountId: string,
  flips: ReadonlyArray<VisibilityFlip>,
): Effect.Effect<void, SqlError, CalendarRepo> =>
  Effect.gen(function* () {
    const calendarRepo = yield* CalendarRepo;
    for (const flip of flips) {
      yield* calendarRepo.setVisible(accountId, flip.id, flip.visible);
    }
  });

export const flipTaskLists = (
  accountId: string,
  flips: ReadonlyArray<VisibilityFlip>,
): Effect.Effect<void, SqlError, TaskRepo> =>
  Effect.gen(function* () {
    const taskRepo = yield* TaskRepo;
    for (const flip of flips) {
      yield* taskRepo.setListVisible(accountId, flip.id, flip.visible);
    }
  });

/**
 * Applies what the parked row holds for this account against the rows now
 * in the database and drops what matched. Called after every calendar or
 * list sync; a no-op when nothing is parked. Rows are only touched when
 * their visibility differs, so a repeat pass changes nothing. Returns the
 * number of rows flipped.
 */
export const applyPendingVisibility = (
  account: Account,
): Effect.Effect<number, SqlError, CalendarRepo | DeviceSettingsRepo | TaskRepo> =>
  withPendingVisibilityLock(
    Effect.gen(function* () {
      const pending = yield* readPendingVisibility;
      if (countPendingVisibility(pending) === 0) {
        return 0;
      }
      const calendarRepo = yield* CalendarRepo;
      const taskRepo = yield* TaskRepo;
      let next: PendingVisibility;
      let changed: number;
      if (isAppleCalendarAccount(account)) {
        if (!pending.appleCalendar?.length) {
          return 0;
        }
        const result = matchAppleCalendars(
          yield* calendarRepo.list(account.id),
          pending.appleCalendar,
        );
        yield* flipCalendars(account.id, result.flips);
        changed = result.flips.length;
        next = { ...pending, appleCalendar: result.unmatched };
      } else if (isAppleRemindersAccount(account)) {
        if (!pending.appleReminders?.length) {
          return 0;
        }
        const result = matchAppleTaskLists(
          yield* taskRepo.listLists(account.id),
          pending.appleReminders,
        );
        yield* flipTaskLists(account.id, result.flips);
        changed = result.flips.length;
        next = { ...pending, appleReminders: result.unmatched };
      } else {
        const email = account.email.toLowerCase();
        const entry = pending.google?.[email];
        if (!entry) {
          return 0;
        }
        const calendars = matchGoogleCalendars(
          yield* calendarRepo.list(account.id),
          entry.calendars,
        );
        const taskLists = matchGoogleTaskLists(
          yield* taskRepo.listLists(account.id),
          entry.taskLists,
        );
        yield* flipCalendars(account.id, calendars.flips);
        yield* flipTaskLists(account.id, taskLists.flips);
        changed = calendars.flips.length + taskLists.flips.length;
        next = {
          ...pending,
          google: {
            ...pending.google,
            [email]: { calendars: calendars.unmatched, taskLists: taskLists.unmatched },
          },
        };
      }
      if (countPendingVisibility(next) !== countPendingVisibility(pending)) {
        yield* writePendingVisibility(next);
      }
      return changed;
    }),
  );

/**
 * Drops what the row parks for an account being removed: the export would
 * otherwise keep listing the account from its parked preferences and a
 * re-import would recreate it.
 */
export const clearPendingVisibility = (
  account: Account,
): Effect.Effect<void, SqlError, DeviceSettingsRepo> =>
  withPendingVisibilityLock(
    Effect.gen(function* () {
      const pending = yield* readPendingVisibility;
      if (countPendingVisibility(pending) === 0) {
        return;
      }
      let next: PendingVisibility;
      if (isAppleCalendarAccount(account)) {
        next = { ...pending, appleCalendar: [] };
      } else if (isAppleRemindersAccount(account)) {
        next = { ...pending, appleReminders: [] };
      } else {
        const google = { ...pending.google };
        delete google[account.email.toLowerCase()];
        next = { ...pending, google };
      }
      if (countPendingVisibility(next) !== countPendingVisibility(pending)) {
        yield* writePendingVisibility(next);
      }
    }),
  );
