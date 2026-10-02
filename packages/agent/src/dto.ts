import {
  addDaysToPlainDate,
  type Attendee,
  type CalendarInfo,
  type Contact,
  type EventRecord,
  isCalendarWritable,
  isDeclinedBySelf,
  isTaskListWritable,
  meetingUrl,
  type TaskListInfo,
  type TaskRecord,
} from '@calendar/core';
import type { CalendarLevel, TaskListLevel } from './policy.ts';
import { encodeRef, eventRefOf, taskRefOf } from './refs.ts';
import { formatDateTime } from './times.ts';

/**
 * The shapes agents read. Deliberately not the stored records: refs
 * instead of id triples, ISO times instead of epochs, and none of the
 * sync bookkeeping (etags, private geo keys, sync timestamps).
 */

export interface CalendarDto {
  readonly access: CalendarLevel;
  /** The account's email, or "Apple Calendar". */
  readonly account: string;
  readonly name: string;
  readonly primary: boolean;
  readonly provider: 'apple' | 'google';
  readonly ref: string;
  readonly timeZone: string;
  /** Whether a write can succeed at all: the grant allows it and the provider does too. */
  readonly writable: boolean;
}

export interface TaskListDto {
  readonly access: TaskListLevel;
  readonly account: string;
  readonly name: string;
  readonly provider: 'apple' | 'google';
  readonly ref: string;
  readonly writable: boolean;
}

export interface AttendeeDto {
  readonly email: string;
  readonly name?: string;
  readonly organizer?: true;
  readonly response: Attendee['responseStatus'];
  readonly self?: true;
}

export interface EventDto {
  readonly allDay: boolean;
  readonly attendees?: ReadonlyArray<AttendeeDto>;
  readonly calendar: string;
  readonly description?: string;
  /** Timed events: ISO 8601 with the offset of the user's primary zone. */
  readonly end?: string;
  /** All-day events: the last day, inclusive. */
  readonly endDate?: string;
  readonly location?: string;
  readonly meetingUrl?: string;
  readonly organizer?: string;
  /** True while a local change is still queued for the provider. */
  readonly pendingSync?: true;
  /** One occurrence of a repeating event: writes take a `scope`. */
  readonly recurring: boolean;
  readonly ref: string;
  readonly start?: string;
  readonly startDate?: string;
  readonly status: EventRecord['status'];
  readonly timeZone?: string;
  readonly title: string;
}

export interface TaskDto {
  readonly completed: boolean;
  readonly dueDate?: string;
  readonly dueTime?: string;
  readonly list: string;
  readonly notes?: string;
  readonly priority?: NonNullable<TaskRecord['priority']>;
  readonly recurring?: true;
  readonly ref: string;
  readonly title: string;
  readonly url?: string;
}

export interface BusyBlockDto {
  readonly end: string;
  readonly start: string;
}

export interface ContactDto {
  readonly email: string;
  readonly name?: string;
}

const levelWrites = (level: CalendarLevel | TaskListLevel): boolean =>
  level === 'ask' || level === 'write';

export const toCalendarDto = (
  calendar: CalendarInfo,
  account: string,
  level: CalendarLevel,
): CalendarDto => ({
  access: level,
  account,
  name: calendar.summary,
  primary: calendar.isPrimary,
  provider: calendar.provider,
  ref: encodeRef({ accountId: calendar.accountId, calendarId: calendar.id, kind: 'calendar' }),
  timeZone: calendar.timeZone,
  writable: levelWrites(level) && isCalendarWritable(calendar),
});

export const toTaskListDto = (
  list: TaskListInfo,
  account: string,
  level: TaskListLevel,
): TaskListDto => ({
  access: level,
  account,
  name: list.title,
  provider: list.provider,
  ref: encodeRef({ accountId: list.accountId, kind: 'taskList', taskListId: list.id }),
  writable: levelWrites(level) && isTaskListWritable(list),
});

const toAttendeeDto = (attendee: Attendee): AttendeeDto => ({
  email: attendee.email,
  ...(attendee.displayName === undefined ? {} : { name: attendee.displayName }),
  ...(attendee.isOrganizer ? { organizer: true as const } : {}),
  response: attendee.responseStatus,
  ...(attendee.isSelf ? { self: true as const } : {}),
});

export const toEventDto = (event: EventRecord, timeZone: string): EventDto => {
  const guests = (event.attendees ?? []).filter((attendee) => !attendee.isResource);
  const link = meetingUrl(event);
  return {
    allDay: event.isAllDay,
    ...(guests.length > 0 ? { attendees: guests.map(toAttendeeDto) } : {}),
    calendar: encodeRef({
      accountId: event.accountId,
      calendarId: event.calendarId,
      kind: 'calendar',
    }),
    ...(event.description ? { description: event.description } : {}),
    ...(event.isAllDay && event.startDate !== undefined && event.endDate !== undefined
      ? { endDate: addDaysToPlainDate(event.endDate, -1), startDate: event.startDate }
      : {
          end: formatDateTime(event.endUtc, timeZone),
          start: formatDateTime(event.startUtc, timeZone),
        }),
    ...(event.location ? { location: event.location } : {}),
    ...(link === undefined ? {} : { meetingUrl: link }),
    ...(event.organizerEmail === undefined ? {} : { organizer: event.organizerEmail }),
    ...(event.syncStatus === 'synced' ? {} : { pendingSync: true as const }),
    recurring: event.recurringEventId !== undefined,
    ref: encodeRef(eventRefOf(event)),
    status: event.status,
    ...(event.isAllDay || event.startTimeZone === undefined
      ? {}
      : { timeZone: event.startTimeZone }),
    title: event.title,
  };
};

export const toTaskDto = (task: TaskRecord): TaskDto => ({
  completed: task.status === 'completed',
  ...(task.dueDate === undefined ? {} : { dueDate: task.dueDate }),
  ...(task.dueTime === undefined ? {} : { dueTime: task.dueTime }),
  list: encodeRef({ accountId: task.accountId, kind: 'taskList', taskListId: task.listId }),
  ...(task.notes ? { notes: task.notes } : {}),
  ...(task.priority === undefined ? {} : { priority: task.priority }),
  ...(task.recurrence !== undefined || task.recurrenceUnsupported
    ? { recurring: true as const }
    : {}),
  ref: encodeRef(taskRefOf(task)),
  title: task.title,
  ...(task.url === undefined ? {} : { url: task.url }),
});

export const toContactDto = (contact: Contact): ContactDto => ({
  email: contact.email,
  ...(contact.displayName === undefined ? {} : { name: contact.displayName }),
});

/** Guests other than the user and booked rooms — the people a write would reach. */
export const otherGuests = (
  event: Pick<EventRecord, 'attendees'>,
  accountEmail: string | undefined,
): ReadonlyArray<Attendee> => {
  const own = accountEmail?.toLowerCase();
  return (event.attendees ?? []).filter(
    (attendee) =>
      !attendee.isResource &&
      attendee.isSelf !== true &&
      (own === undefined || attendee.email.toLowerCase() !== own),
  );
};

/**
 * What blocks time: timed, not cancelled, not declined. All-day entries
 * mark days rather than hours, exactly as find-a-time treats them.
 */
export const isBusy = (event: EventRecord, accountEmail: string | undefined): boolean =>
  !event.isAllDay && event.status !== 'cancelled' && !isDeclinedBySelf(event, accountEmail);

// Shared with the availability mirror, so they live in core.
export { isDeclinedBySelf, mergeBusy } from '@calendar/core';

export const toBusyBlockDto = (
  interval: { readonly endUtc: number; readonly startUtc: number },
  timeZone: string,
): BusyBlockDto => ({
  end: formatDateTime(interval.endUtc, timeZone),
  start: formatDateTime(interval.startUtc, timeZone),
});
