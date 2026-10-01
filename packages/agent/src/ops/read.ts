import {
  addDaysToPlainDate,
  daysBetweenPlainDates,
  type EventRecord,
  findFreeSlots,
  isValidTimeZone,
  plainDateToUtcMs,
  rankContacts,
  Temporal,
} from '@calendar/core';
import { ContactRepo, TaskRepo } from '@calendar/db';
import { DeviceContacts, loadEventsInRange } from '@calendar/sync';
import { Clock, Effect } from 'effect';
import type { ToolInput } from '../contract.ts';
import {
  type BusyBlockDto,
  type CalendarDto,
  type ContactDto,
  type EventDto,
  isBusy,
  mergeBusy,
  type TaskDto,
  type TaskListDto,
  toBusyBlockDto,
  toCalendarDto,
  toContactDto,
  toEventDto,
  toTaskDto,
  toTaskListDto,
} from '../dto.ts';
import { AgentInvalidInputError, AgentPermissionDeniedError } from '../errors.ts';
import { type AgentPolicy, canSeeDetails } from '../policy.ts';
import {
  type Directory,
  type GrantedCalendar,
  resolveCalendarFilter,
  resolveTaskListFilter,
} from '../resolve.ts';
import { formatDateTime, isIsoDate, parseDateTime } from '../times.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Recurrence expansion runs on the main thread: a range is bounded so one call cannot stall the app. */
const MAX_RANGE_DAYS = 400;
const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 2000;
const MAX_SLOT_SEARCH_DAYS = 92;
const DEFAULT_TASK_WINDOW_DAYS = 30;

const invalid = (message: string) => Effect.fail(new AgentInvalidInputError({ message }));

const zoneFor = (requested: string | undefined, directory: Directory) =>
  requested === undefined
    ? Effect.succeed(directory.timeZone)
    : isValidTimeZone(requested)
      ? Effect.succeed(requested)
      : invalid(`Unknown time zone "${requested}"; use an IANA id such as Europe/Vienna.`);

const rangeOf = (from: string, to: string, timeZone: string) =>
  Effect.gen(function* () {
    const startUtc = parseDateTime(from, timeZone);
    const endUtc = parseDateTime(to, timeZone);
    if (startUtc === undefined || endUtc === undefined) {
      return yield* invalid('from and to must be ISO 8601 date-times or YYYY-MM-DD dates.');
    }
    if (endUtc <= startUtc) {
      return yield* invalid('to must be after from.');
    }
    if (endUtc - startUtc > MAX_RANGE_DAYS * DAY_MS) {
      return yield* invalid(`A range may span at most ${MAX_RANGE_DAYS} days.`);
    }
    return { endUtc, startUtc };
  });

const keyOf = (accountId: string, calendarId: string): string => `${accountId}\u0000${calendarId}`;

const index = (calendars: ReadonlyArray<GrantedCalendar>): Map<string, GrantedCalendar> =>
  new Map(calendars.map((entry) => [keyOf(entry.calendar.accountId, entry.calendar.id), entry]));

const matchesQuery = (event: EventRecord, needle: string): boolean =>
  [
    event.title,
    event.description,
    event.location,
    ...(event.attendees ?? []).flatMap((attendee) => [attendee.email, attendee.displayName]),
  ].some((field) => field?.toLowerCase().includes(needle));

export const listCalendars = (
  directory: Directory,
): { readonly calendars: ReadonlyArray<CalendarDto> } => ({
  calendars: directory.calendars.map((entry) =>
    toCalendarDto(entry.calendar, directory.accountLabel(entry.calendar.accountId), entry.level),
  ),
});

export const listTaskLists = (
  directory: Directory,
): { readonly taskLists: ReadonlyArray<TaskListDto> } => ({
  taskLists: directory.taskLists.map((entry) =>
    toTaskListDto(entry.list, directory.accountLabel(entry.list.accountId), entry.level),
  ),
});

export const listEvents = (directory: Directory, input: ToolInput<'list_events'>) =>
  Effect.gen(function* () {
    const timeZone = yield* zoneFor(input.timeZone, directory);
    const range = yield* rangeOf(input.from, input.to, timeZone);
    const limit = Math.min(
      MAX_EVENT_LIMIT,
      Math.max(1, Math.floor(input.limit ?? DEFAULT_EVENT_LIMIT)),
    );
    // Free/busy-only calendars never yield details, even when named in the filter.
    const readable = index(
      (yield* resolveCalendarFilter(directory, input.calendars)).filter((entry) =>
        canSeeDetails(entry.level),
      ),
    );
    const needle = input.query?.trim().toLowerCase();
    const events = (yield* loadEventsInRange(range.startUtc, range.endUtc)).filter(
      (event) =>
        event.status !== 'cancelled' &&
        readable.has(keyOf(event.accountId, event.calendarId)) &&
        (needle === undefined || needle === '' || matchesQuery(event, needle)),
    );
    const result: {
      readonly events: ReadonlyArray<EventDto>;
      readonly timeZone: string;
      readonly truncated?: true;
    } = {
      events: events.slice(0, limit).map((event) => toEventDto(event, timeZone)),
      timeZone,
      ...(events.length > limit ? { truncated: true as const } : {}),
    };
    return result;
  });

/** Events that block time, from every calendar the grant shows busy time of. */
const busyEvents = (
  directory: Directory,
  calendars: ReadonlyArray<GrantedCalendar>,
  startUtc: number,
  endUtc: number,
) =>
  Effect.gen(function* () {
    const visible = index(calendars);
    return (yield* loadEventsInRange(startUtc, endUtc)).filter((event) => {
      const entry = visible.get(keyOf(event.accountId, event.calendarId));
      return entry !== undefined && isBusy(event, entry.account?.email);
    });
  });

export const getFreeBusy = (directory: Directory, input: ToolInput<'get_free_busy'>) =>
  Effect.gen(function* () {
    const timeZone = yield* zoneFor(input.timeZone, directory);
    const range = yield* rangeOf(input.from, input.to, timeZone);
    const calendars = yield* resolveCalendarFilter(directory, input.calendars);
    const events = yield* busyEvents(directory, calendars, range.startUtc, range.endUtc);
    const result: { readonly busy: ReadonlyArray<BusyBlockDto>; readonly timeZone: string } = {
      busy: mergeBusy(events, range).map((interval) => toBusyBlockDto(interval, timeZone)),
      timeZone,
    };
    return result;
  });

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/u;

export const findSlots = (directory: Directory, input: ToolInput<'find_free_slots'>) =>
  Effect.gen(function* () {
    const timeZone = yield* zoneFor(input.timeZone, directory);
    if (!isIsoDate(input.fromDate) || !isIsoDate(input.toDate)) {
      return yield* invalid('fromDate and toDate must be real dates in YYYY-MM-DD form.');
    }
    const days = daysBetweenPlainDates(input.fromDate, input.toDate);
    if (days < 0) {
      return yield* invalid('toDate must not be before fromDate.');
    }
    if (days > MAX_SLOT_SEARCH_DAYS) {
      return yield* invalid(`A slot search may span at most ${MAX_SLOT_SEARCH_DAYS} days.`);
    }
    if (!(input.durationMinutes > 0) || input.durationMinutes > 24 * 60) {
      return yield* invalid('durationMinutes must be between 1 and 1440.');
    }
    for (const bound of [input.earliestTime, input.latestTime]) {
      if (bound !== undefined && !CLOCK.test(bound)) {
        return yield* invalid('earliestTime and latestTime must be HH:MM (24h).');
      }
    }
    const calendars = yield* resolveCalendarFilter(directory, input.calendars);
    // Padded by a day on each side: the wall-clock window is in `timeZone`, the index is UTC.
    const events = yield* busyEvents(
      directory,
      calendars,
      plainDateToUtcMs(input.fromDate) - DAY_MS,
      plainDateToUtcMs(input.toDate) + 2 * DAY_MS,
    );
    const slots = findFreeSlots(
      events,
      {
        daysOfWeek: input.daysOfWeek,
        durationMinutes: input.durationMinutes,
        earliestTime: input.earliestTime,
        latestTime: input.latestTime,
        windowEndDate: input.toDate,
        windowStartDate: input.fromDate,
      },
      {
        maxSlots: Math.min(50, Math.max(1, Math.floor(input.maxSlots ?? 10))),
        nowUtc: yield* Clock.currentTimeMillis,
        timeZone,
      },
    );
    const instant = (date: string, time: string): string =>
      formatDateTime(
        Temporal.PlainDate.from(date)
          .toZonedDateTime({ plainTime: Temporal.PlainTime.from(time), timeZone })
          .toInstant().epochMilliseconds,
        timeZone,
      );
    return {
      slots: slots.map((slot) => ({
        end: instant(slot.date, slot.endTime),
        start: instant(slot.date, slot.startTime),
      })),
      timeZone,
    };
  });

export const listTasks = (directory: Directory, input: ToolInput<'list_tasks'>) =>
  Effect.gen(function* () {
    const today = Temporal.Instant.fromEpochMilliseconds(yield* Clock.currentTimeMillis)
      .toZonedDateTimeISO(directory.timeZone)
      .toPlainDate()
      .toString();
    const fromDate = input.fromDate ?? today;
    const toDate = input.toDate ?? addDaysToPlainDate(fromDate, DEFAULT_TASK_WINDOW_DAYS);
    if (!isIsoDate(fromDate) || !isIsoDate(toDate)) {
      return yield* invalid('fromDate and toDate must be real dates in YYYY-MM-DD form.');
    }
    const days = daysBetweenPlainDates(fromDate, toDate);
    if (days < 0) {
      return yield* invalid('toDate must not be before fromDate.');
    }
    if (days > MAX_RANGE_DAYS) {
      return yield* invalid(`A range may span at most ${MAX_RANGE_DAYS} days.`);
    }
    const lists = new Set(
      (yield* resolveTaskListFilter(directory, input.lists))
        .filter((entry) => canSeeDetails(entry.level))
        .map((entry) => keyOf(entry.list.accountId, entry.list.id)),
    );
    const repo = yield* TaskRepo;
    const due = yield* repo.getWindow(fromDate, toDate);
    const overdue = input.includeOverdue === false ? [] : yield* repo.getOverdue(fromDate);
    const result: { readonly tasks: ReadonlyArray<TaskDto> } = {
      tasks: [...overdue, ...due]
        .filter((task) => lists.has(keyOf(task.accountId, task.listId)))
        .map(toTaskDto),
    };
    return result;
  });

export const searchContacts = (policy: AgentPolicy, input: ToolInput<'search_contacts'>) =>
  Effect.gen(function* () {
    if (!policy.contacts) {
      return yield* Effect.fail(
        new AgentPermissionDeniedError({
          message:
            'This agent has no access to contacts. The user can allow it in Solunivo → Settings → Agents.',
          reason: 'contacts',
        }),
      );
    }
    const take = Math.min(25, Math.max(1, Math.floor(input.limit ?? 8)));
    const google = yield* (yield* ContactRepo).search(input.query, take * 4);
    const device = yield* (yield* DeviceContacts).list();
    const result: { readonly contacts: ReadonlyArray<ContactDto> } = {
      contacts: rankContacts(input.query, [...google, ...device], take).map(toContactDto),
    };
    return result;
  });
