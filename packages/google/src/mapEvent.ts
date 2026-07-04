import { Attendee, CalendarInfo, EventRecord, plainDateToUtcMs, Temporal } from '@calendar/core';
import type { GcalCalendarListEntry, GcalEvent, GcalEventInput, GcalTime } from './apiTypes.ts';
import { Schema } from 'effect';

type GcalTimeValue = Schema.Schema.Type<typeof GcalTime>;

const toEpochMs = (time: GcalTimeValue | undefined): number | undefined => {
  if (time?.dateTime) {
    return Temporal.Instant.from(time.dateTime).epochMilliseconds;
  }
  if (time?.date) {
    return plainDateToUtcMs(time.date);
  }
  return undefined;
};

const RESPONSE_STATUSES = new Set(['accepted', 'declined', 'needsAction', 'tentative']);
const EVENT_STATUSES = new Set(['cancelled', 'confirmed', 'tentative']);
const ACCESS_ROLES = new Set(['freeBusyReader', 'owner', 'reader', 'writer']);

/**
 * Converts a Google event resource into the domain record. Returns null for
 * payloads without usable times (cancelled tombstones — handled separately).
 */
export const mapGcalEvent = (
  event: GcalEvent,
  context: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly defaultTimeZone: string;
    readonly syncedAt: number;
  },
): EventRecord | null => {
  const startUtc = toEpochMs(event.start);
  const endUtc = toEpochMs(event.end);
  if (startUtc === undefined || endUtc === undefined) {
    return null;
  }
  const isAllDay = event.start?.date !== undefined;
  const status = EVENT_STATUSES.has(event.status ?? '')
    ? (event.status as 'cancelled' | 'confirmed' | 'tentative')
    : 'confirmed';

  const attendees = event.attendees
    ?.filter((attendee) => attendee.email && !attendee.resource)
    .map(
      (attendee) =>
        new Attendee({
          displayName: attendee.displayName,
          email: attendee.email ?? '',
          isOrganizer: attendee.organizer,
          isSelf: attendee.self,
          responseStatus: RESPONSE_STATUSES.has(attendee.responseStatus ?? '')
            ? (attendee.responseStatus as 'accepted' | 'declined' | 'needsAction' | 'tentative')
            : 'needsAction',
        }),
    );

  return new EventRecord({
    accountId: context.accountId,
    attendees: attendees && attendees.length > 0 ? attendees : undefined,
    calendarId: context.calendarId,
    description: event.description,
    endDate: event.end?.date,
    endUtc,
    etag: event.etag ?? null,
    id: event.id,
    isAllDay,
    location: event.location,
    organizerEmail: event.organizer?.email,
    originalStartUtc: toEpochMs(event.originalStartTime),
    recurrence: event.recurrence,
    recurringEventId: event.recurringEventId,
    startDate: event.start?.date,
    startTimeZone: isAllDay ? undefined : (event.start?.timeZone ?? context.defaultTimeZone),
    startUtc,
    status,
    syncedAt: context.syncedAt,
    syncStatus: 'synced',
    title: event.summary ?? '(no title)',
    updatedAt: event.updated
      ? Temporal.Instant.from(event.updated).epochMilliseconds
      : context.syncedAt,
  });
};

export const mapGcalCalendar = (
  entry: GcalCalendarListEntry,
  context: {
    readonly accountId: string;
    readonly colorFromId: (colorId: string) => string | undefined;
    readonly previousVisibility?: boolean | undefined;
  },
): CalendarInfo =>
  new CalendarInfo({
    accessRole: ACCESS_ROLES.has(entry.accessRole ?? '')
      ? (entry.accessRole as 'freeBusyReader' | 'owner' | 'reader' | 'writer')
      : 'reader',
    accountId: context.accountId,
    colorHex:
      entry.backgroundColor ??
      (entry.colorId ? context.colorFromId(entry.colorId) : undefined) ??
      '#4285f4',
    id: entry.id,
    isPrimary: entry.primary ?? false,
    isVisible: context.previousVisibility ?? entry.selected ?? true,
    summary: entry.summaryOverride ?? entry.summary ?? entry.id,
    timeZone: entry.timeZone ?? 'UTC',
  });

/** Builds the insert/patch payload from a local event record. */
export const toGcalEventInput = (event: EventRecord): GcalEventInput => ({
  description: event.description,
  end: event.isAllDay
    ? { date: event.endDate }
    : {
        dateTime: Temporal.Instant.fromEpochMilliseconds(event.endUtc).toString(),
        timeZone: event.startTimeZone,
      },
  id: event.id,
  location: event.location,
  recurrence: event.recurrence,
  start: event.isAllDay
    ? { date: event.startDate }
    : {
        dateTime: Temporal.Instant.fromEpochMilliseconds(event.startUtc).toString(),
        timeZone: event.startTimeZone,
      },
  summary: event.title,
});
