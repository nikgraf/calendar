import {
  AppleCalendarClient,
  type AppleCalendarError,
  isNotFound,
  mapAppleEvent,
} from '@calendar/apple-calendar';
import {
  type Account,
  addDaysToPlainDate,
  assembleWindow,
  type CalendarInfo,
  daysBetweenPlainDates,
  type EventRecord,
  isAppleCalendarAccount,
  isAppleRemindersAccount,
  type TaskListInfo,
  type TaskRecord,
  utcMsToPlainDate,
} from '@calendar/core';
import { AccountRepo, CalendarRepo, DeviceSettingsRepo, EventRepo, TaskRepo } from '@calendar/db';
import { deviceTimeZone } from '@calendar/sync';
import { readPrimaryTimeZone } from '@calendar/sync/deviceSettings';
import { Clock, Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import {
  AgentFailedError,
  AgentInvalidInputError,
  AgentNotFoundError,
  type AgentError,
} from './errors.ts';
import {
  type AgentPolicy,
  calendarLevel,
  type CalendarLevel,
  canSeeDetails,
  taskListLevel,
  type TaskListLevel,
} from './policy.ts';
import {
  decodeCalendarRef,
  decodeEventRef,
  decodeTaskListRef,
  decodeTaskRef,
  type EventRef,
  type TaskRef,
} from './refs.ts';
import type { ExistingTimes } from './times.ts';

/** The accounts, calendars and lists of one call, with the agent's level on each. */
export interface Directory {
  readonly accountLabel: (accountId: string) => string;
  readonly accounts: ReadonlyMap<string, Account>;
  /** Every calendar the agent can at least see busy time of (visible in the app, level above none). */
  readonly calendars: ReadonlyArray<GrantedCalendar>;
  readonly taskLists: ReadonlyArray<GrantedTaskList>;
  /** The user's primary zone — what offset-less input is read in and output is written in. */
  readonly timeZone: string;
}

export interface GrantedCalendar {
  readonly account: Account | undefined;
  readonly calendar: CalendarInfo;
  readonly level: CalendarLevel;
}

export interface GrantedTaskList {
  readonly account: Account | undefined;
  readonly level: TaskListLevel;
  readonly list: TaskListInfo;
}

const accountLabelOf = (account: Account | undefined): string => {
  if (!account) {
    return 'Unknown account';
  }
  if (isAppleCalendarAccount(account)) {
    return 'Apple Calendar';
  }
  if (isAppleRemindersAccount(account)) {
    return 'Apple Reminders';
  }
  return account.email;
};

/**
 * Hidden calendars and lists are `none` for every agent: the range reads
 * only return visible ones, so a grant never shows more than the app does.
 */
export const loadDirectory = (
  policy: AgentPolicy,
): Effect.Effect<Directory, SqlError, AccountRepo | CalendarRepo | DeviceSettingsRepo | TaskRepo> =>
  Effect.gen(function* () {
    const accounts = new Map(
      (yield* (yield* AccountRepo).list()).map((account) => [account.id, account]),
    );
    const calendars = (yield* (yield* CalendarRepo).list())
      .filter((calendar) => calendar.isVisible)
      .map((calendar) => ({
        account: accounts.get(calendar.accountId),
        calendar,
        level: calendarLevel(policy, { accountId: calendar.accountId, calendarId: calendar.id }),
      }))
      .filter((entry) => entry.level !== 'none');
    const taskLists = (yield* (yield* TaskRepo).listLists())
      .filter((list) => list.isVisible)
      .map((list) => ({
        account: accounts.get(list.accountId),
        level: taskListLevel(policy, { accountId: list.accountId, taskListId: list.id }),
        list,
      }))
      .filter((entry) => entry.level !== 'none');
    const timeZone = yield* readPrimaryTimeZone;
    return {
      accountLabel: (accountId) => accountLabelOf(accounts.get(accountId)),
      accounts,
      calendars,
      taskLists,
      timeZone,
    };
  });

export const findCalendar = (
  directory: Directory,
  target: { readonly accountId: string; readonly calendarId: string },
): GrantedCalendar | undefined =>
  directory.calendars.find(
    (entry) =>
      entry.calendar.accountId === target.accountId && entry.calendar.id === target.calendarId,
  );

export const findTaskList = (
  directory: Directory,
  target: { readonly accountId: string; readonly taskListId: string },
): GrantedTaskList | undefined =>
  directory.taskLists.find(
    (entry) => entry.list.accountId === target.accountId && entry.list.id === target.taskListId,
  );

const notACalendarRef = new AgentInvalidInputError({
  message: 'That is not a calendar ref; use a `ref` returned by list_calendars.',
});
const notAnEventRef = new AgentInvalidInputError({
  message: 'That is not an event ref; use a `ref` returned by list_events.',
});
const notAListRef = new AgentInvalidInputError({
  message: 'That is not a task list ref; use a `ref` returned by list_task_lists.',
});
const notATaskRef = new AgentInvalidInputError({
  message: 'That is not a task ref; use a `ref` returned by list_tasks.',
});

/** A calendar the agent can see (any level above none). */
export const resolveCalendar = (
  directory: Directory,
  ref: string,
): Effect.Effect<GrantedCalendar, AgentError> => {
  const decoded = decodeCalendarRef(ref);
  if (!decoded) {
    return Effect.fail(notACalendarRef);
  }
  const found = findCalendar(directory, decoded);
  return found ? Effect.succeed(found) : Effect.fail(new AgentNotFoundError({ what: 'Calendar' }));
};

export const resolveTaskList = (
  directory: Directory,
  ref: string,
): Effect.Effect<GrantedTaskList, AgentError> => {
  const decoded = decodeTaskListRef(ref);
  if (!decoded) {
    return Effect.fail(notAListRef);
  }
  const found = findTaskList(directory, decoded);
  return found ? Effect.succeed(found) : Effect.fail(new AgentNotFoundError({ what: 'Task list' }));
};

/** Sets of calendars/lists an optional filter narrows a read to. */
export const resolveCalendarFilter = (
  directory: Directory,
  refs: ReadonlyArray<string> | undefined,
): Effect.Effect<ReadonlyArray<GrantedCalendar>, AgentError> =>
  refs === undefined
    ? Effect.succeed(directory.calendars)
    : Effect.forEach(refs, (ref) => resolveCalendar(directory, ref));

export const resolveTaskListFilter = (
  directory: Directory,
  refs: ReadonlyArray<string> | undefined,
): Effect.Effect<ReadonlyArray<GrantedTaskList>, AgentError> =>
  refs === undefined
    ? Effect.succeed(directory.taskLists)
    : Effect.forEach(refs, (ref) => resolveTaskList(directory, ref));

export interface ResolvedEvent {
  /** The times a change to just this event or occurrence starts from (its own, if it was moved). */
  readonly base: ExistingTimes;
  /**
   * For an occurrence: the series' live exceptions — occurrences changed
   * on their own. A series-wide or "following" write rewrites or cancels
   * them too, so their guests count. Apple: those EventKit returns within
   * the searched window around the slot.
   */
  readonly exceptions?: ReadonlyArray<EventRecord>;
  readonly granted: GrantedCalendar;
  /** The event itself; for an occurrence, the occurrence as it is now (a moved or edited one included). */
  readonly record: EventRecord;
  readonly ref: EventRef;
  /** For an occurrence: the series master (guests on it are reached by a series-wide write). */
  readonly series?: EventRecord;
  /** For an occurrence: its slot in the series — what a series-wide or "following" change starts from. */
  readonly slotBase?: ExistingTimes;
}

const eventNotFound = new AgentNotFoundError({ what: 'Event' });

/** How far from its slot a moved Apple occurrence is still looked for (EventKit only answers ranges). */
const APPLE_OCCURRENCE_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;
/** The wider search for a series-wide or "following" write, which must see the other exceptions too. */
const APPLE_SERIES_WINDOW_MS = 400 * 24 * 60 * 60 * 1000;

const slotTimes = (master: EventRecord, originalStartUtc: number): ExistingTimes => {
  if (master.isAllDay && master.startDate !== undefined && master.endDate !== undefined) {
    const startDate = utcMsToPlainDate(originalStartUtc);
    const span = Math.max(1, daysBetweenPlainDates(master.startDate, master.endDate));
    return {
      endDate: addDaysToPlainDate(startDate, span),
      endUtc: originalStartUtc + (master.endUtc - master.startUtc),
      isAllDay: true,
      startDate,
      startUtc: originalStartUtc,
    };
  }
  return {
    endUtc: originalStartUtc + (master.endUtc - master.startUtc),
    isAllDay: false,
    startTimeZone: master.startTimeZone,
    startUtc: originalStartUtc,
  };
};

const ownTimes = (record: EventRecord): ExistingTimes => ({
  endDate: record.endDate,
  endUtc: record.endUtc,
  isAllDay: record.isAllDay,
  startDate: record.startDate,
  startTimeZone: record.startTimeZone,
  startUtc: record.startUtc,
});

/** Whether the series' rule really produces an occurrence at this slot. */
const ruleProduces = (master: EventRecord, originalStartUtc: number): boolean => {
  let failed = false;
  const occurrences = assembleWindow(
    { masters: [master], overrides: [], singles: [] },
    originalStartUtc,
    originalStartUtc + 1,
    () => {
      failed = true;
    },
  );
  return (
    !failed && occurrences.some((occurrence) => occurrence.originalStartUtc === originalStartUtc)
  );
};

/**
 * Finds the event a ref names and the calendar it REALLY lives in. This
 * is the gateway's defence against a confused deputy: EventKit addresses
 * an event by id alone and ignores the calendar a caller names, so a ref
 * that pairs a granted calendar with another calendar's event must not
 * resolve. Apple: EventKit says where the event is. Google: the row is
 * keyed by its calendar. Anything the agent cannot read in full is "not
 * found" — exactly what a non-existent event answers.
 *
 * An occurrence ref must name a real occurrence: a slot the series does
 * not have (a made-up one, or one that was deleted) is not found either,
 * so a write can neither invent an exception nor answer "done" for
 * nothing.
 */
export const resolveEvent = (
  directory: Directory,
  refText: string,
  options: {
    /** The write reaches beyond one occurrence: look further for the series' other exceptions. */
    readonly wholeSeries?: boolean;
  } = {},
): Effect.Effect<ResolvedEvent, AgentError | SqlError, AppleCalendarClient | EventRepo> =>
  Effect.gen(function* () {
    const ref = decodeEventRef(refText);
    if (!ref) {
      return yield* Effect.fail(notAnEventRef);
    }
    const granted = findCalendar(directory, ref);
    if (!granted || !canSeeDetails(granted.level)) {
      return yield* Effect.fail(eventNotFound);
    }
    const id = ref.kind === 'event' ? ref.eventId : ref.masterId;

    if (isAppleCalendarAccount({ id: ref.accountId })) {
      const client = yield* AppleCalendarClient;
      const appleFailure = (error: AppleCalendarError): AgentError =>
        isNotFound(error)
          ? eventNotFound
          : new AgentFailedError({ message: String(error), tag: error._tag });
      const series = yield* client.series({ id }).pipe(Effect.mapError(appleFailure));
      if (series.first.calendarId !== ref.calendarId) {
        return yield* Effect.fail(eventNotFound);
      }
      const context = { deviceTimeZone: deviceTimeZone(), now: yield* Clock.currentTimeMillis };
      const first = mapAppleEvent(series.first, context);
      if (ref.kind === 'event') {
        return { base: ownTimes(first), granted, record: first, ref };
      }
      // The occurrence as EventKit has it now — one that was moved or
      // renamed on its own differs from the series' first occurrence.
      const reach = options.wholeSeries ? APPLE_SERIES_WINDOW_MS : APPLE_OCCURRENCE_WINDOW_MS;
      const nearby = yield* client
        .events({
          endUtc: ref.originalStartUtc + reach,
          startUtc: ref.originalStartUtc - reach,
        })
        .pipe(Effect.mapError(appleFailure));
      const found = nearby.find(
        (event) =>
          event.id === id &&
          event.occurrenceStartUtc === ref.originalStartUtc &&
          event.calendarId === ref.calendarId &&
          event.status !== 'cancelled',
      );
      if (!found) {
        return yield* Effect.fail(eventNotFound);
      }
      const occurrence = mapAppleEvent(found, context);
      return {
        base: ownTimes(occurrence),
        exceptions: nearby
          .filter((event) => event.id === id && event.isDetached && event.status !== 'cancelled')
          .map((event) => mapAppleEvent(event, context)),
        granted,
        record: occurrence,
        ref,
        series: first,
        slotBase: slotTimes(first, ref.originalStartUtc),
      };
    }

    const events = yield* EventRepo;
    const stored = yield* events.getById(ref.accountId, ref.calendarId, id);
    if (!stored || stored.status === 'cancelled') {
      return yield* Effect.fail(eventNotFound);
    }
    if (ref.kind === 'event') {
      return { base: ownTimes(stored), granted, record: stored, ref };
    }
    if (!stored.recurrence || stored.recurrence.length === 0) {
      return yield* Effect.fail(eventNotFound);
    }
    const overrides = yield* events.listOverrides(ref.accountId, ref.calendarId, id);
    const exception = overrides.find(
      (override) => override.originalStartUtc === ref.originalStartUtc,
    );
    // A cancelled exception is a deleted occurrence; without an exception
    // the rule itself has to produce the slot.
    if (
      exception ? exception.status === 'cancelled' : !ruleProduces(stored, ref.originalStartUtc)
    ) {
      return yield* Effect.fail(eventNotFound);
    }
    return {
      base: exception ? ownTimes(exception) : slotTimes(stored, ref.originalStartUtc),
      exceptions: overrides.filter((override) => override.status !== 'cancelled'),
      granted,
      record: exception ?? stored,
      ref,
      series: stored,
      slotBase: slotTimes(stored, ref.originalStartUtc),
    };
  });

export interface ResolvedTask {
  readonly granted: GrantedTaskList;
  readonly ref: TaskRef;
  readonly task: TaskRecord;
}

const taskNotFound = new AgentNotFoundError({ what: 'Task' });

/**
 * Same defence for tasks: Reminders addresses a reminder by id alone, so
 * the mirror row — keyed by the list the reminder is really in — decides
 * which list's grant applies.
 */
export const resolveTask = (
  directory: Directory,
  refText: string,
): Effect.Effect<ResolvedTask, AgentError | SqlError, TaskRepo> =>
  Effect.gen(function* () {
    const ref = decodeTaskRef(refText);
    if (!ref) {
      return yield* Effect.fail(notATaskRef);
    }
    const granted = findTaskList(directory, ref);
    if (!granted || !canSeeDetails(granted.level)) {
      return yield* Effect.fail(taskNotFound);
    }
    const task = yield* (yield* TaskRepo).get(ref.accountId, ref.taskListId, ref.taskId);
    if (!task) {
      return yield* Effect.fail(taskNotFound);
    }
    return { granted, ref, task };
  });
