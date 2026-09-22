import { StructuredRule } from '@calendar/core';
import { Schema } from 'effect';

/**
 * The Apple Calendar JSON contract shared by three implementations: this
 * TS client, the macOS Swift helper (`calendar.*` stdio methods) and the
 * iOS Expo module. Both native sides compile one Swift source
 * (packages/apple-calendar/swift/AppleCalendarBridge.swift); the schemas
 * here decode what comes back so drift fails loudly at the boundary.
 *
 * Conventions (mirrored in Swift):
 * - instants are epoch ms; all-day events also carry `startDate` and an
 *   **exclusive** `endDate` ('YYYY-MM-DD', Gregorian) — EventKit's own end
 *   is the last day's end, the bridge converts.
 * - `timeZone` absent = a floating event (wall clock in whatever zone the
 *   device is in).
 * - `occurrenceStartUtc` is EventKit's `occurrenceDate`: the slot an
 *   occurrence of a series was generated for. It survives the occurrence
 *   being moved on its own, so it is the occurrence's identity within the
 *   series (with the series' `id`). Present iff the event repeats or is a
 *   detached occurrence.
 * - recurrence crosses as structured rules (core `StructuredRule`); RRULE
 *   text exists only on the TS side.
 * - Nothing is ever fetched without a range: EventKit expands series
 *   itself and only answers bounded queries.
 */

export const CalendarAuthorization = Schema.Literals([
  'denied',
  'fullAccess',
  'notDetermined',
  'restricted',
  'unavailable',
  'writeOnly',
]);
export type CalendarAuthorization = typeof CalendarAuthorization.Type;

export const AppleCalendarJson = Schema.Struct({
  allowsModifications: Schema.Boolean,
  colorHex: Schema.optional(Schema.String),
  id: Schema.String,
  /** EventKit's default calendar for new events. */
  isDefault: Schema.Boolean,
  /** EKSource.title: "iCloud", "On My Mac", an Exchange or CalDAV account name… */
  sourceTitle: Schema.String,
  sourceType: Schema.Literals([
    'birthdays',
    'calDAV',
    'exchange',
    'local',
    'mobileMe',
    'other',
    'subscribed',
  ]),
  title: Schema.String,
  type: Schema.Literals(['birthday', 'calDAV', 'exchange', 'local', 'other', 'subscription']),
});
export type AppleCalendarJson = typeof AppleCalendarJson.Type;

export const AppleGeoJson = Schema.Struct({
  lat: Schema.Number,
  lng: Schema.Number,
  name: Schema.optional(Schema.String),
});
export type AppleGeoJson = typeof AppleGeoJson.Type;

export const AppleAttendeeJson = Schema.Struct({
  email: Schema.String,
  isOrganizer: Schema.Boolean,
  isSelf: Schema.Boolean,
  name: Schema.optional(Schema.String),
  status: Schema.Literals(['accepted', 'declined', 'needsAction', 'tentative']),
});
export type AppleAttendeeJson = typeof AppleAttendeeJson.Type;

export const AppleEventJson = Schema.Struct({
  /**
   * Relative alarm offsets in minutes, EventKit sign (≤ 0 = before/at the
   * start; all-day: before local midnight). Absolute-date alarms are
   * neither listed nor touched, like the Reminders protocol.
   */
  alarms: Schema.optional(Schema.Array(Schema.Number)),
  /** Read-only: EventKit cannot invite or change guests. */
  attendees: Schema.optional(Schema.Array(AppleAttendeeJson)),
  calendarId: Schema.String,
  description: Schema.optional(Schema.String),
  /** All-day only, exclusive. */
  endDate: Schema.optional(Schema.String),
  endUtc: Schema.Number,
  geo: Schema.optional(AppleGeoJson),
  hasRecurrence: Schema.Boolean,
  /** EKEvent.eventIdentifier — shared by every occurrence of a series. */
  id: Schema.String,
  isAllDay: Schema.Boolean,
  isDetached: Schema.Boolean,
  location: Schema.optional(Schema.String),
  occurrenceStartUtc: Schema.optional(Schema.Number),
  organizerEmail: Schema.optional(Schema.String),
  /** The current user organizes the event; the organizer is often not in `attendees`. */
  organizerIsSelf: Schema.optional(Schema.Boolean),
  /** All-day only. */
  startDate: Schema.optional(Schema.String),
  startUtc: Schema.Number,
  status: Schema.Literals(['cancelled', 'confirmed', 'tentative']),
  timeZone: Schema.optional(Schema.String),
  title: Schema.String,
  updatedAt: Schema.Number,
  url: Schema.optional(Schema.String),
});
export type AppleEventJson = typeof AppleEventJson.Type;

/**
 * Fields a write may carry. Like the Reminders protocol, `null` clears a
 * field and a missing key leaves it alone. `recurrence` is only honoured
 * on create and on a `futureEvents` write of a series.
 */
export interface EventWrite {
  /** Replaces the relative alarms (null = none); absolute ones stay. */
  readonly alarms?: ReadonlyArray<number> | null | undefined;
  readonly description?: string | null | undefined;
  readonly endDate?: string | undefined;
  readonly endUtc?: number | undefined;
  readonly geo?: AppleGeoJson | null | undefined;
  readonly isAllDay?: boolean | undefined;
  readonly location?: string | null | undefined;
  readonly recurrence?: ReadonlyArray<StructuredRule> | null | undefined;
  readonly startDate?: string | undefined;
  readonly startUtc?: number | undefined;
  /** null = floating. */
  readonly timeZone?: string | null | undefined;
  readonly title?: string | undefined;
  readonly url?: string | null | undefined;
}

/** EKSpan: this occurrence only, or it and every later one. */
export const Span = Schema.Literals(['futureEvents', 'thisEvent']);
export type Span = typeof Span.Type;

/** A single event (`originalStartUtc` absent) or one occurrence of a series. */
export interface OccurrenceRef {
  readonly id: string;
  readonly originalStartUtc?: number | undefined;
}

export const StatusResult = Schema.Struct({ authorization: CalendarAuthorization });
export const RequestAccessResult = Schema.Struct({ granted: Schema.Boolean });
export const ListCalendarsResult = Schema.Struct({ calendars: Schema.Array(AppleCalendarJson) });
export const EventsResult = Schema.Struct({ events: Schema.Array(AppleEventJson) });
export const EventResult = Schema.Struct({ event: AppleEventJson });
/**
 * A series as a whole: its first occurrence, its rules, and how many
 * occurrences were changed on their own (what a cross-provider move
 * drops). For a single event `rules` is empty and `detachedCount` 0.
 */
export const SeriesResult = Schema.Struct({
  detachedCount: Schema.Number,
  first: AppleEventJson,
  rules: Schema.Array(StructuredRule),
});
export type SeriesResult = typeof SeriesResult.Type;

export const APPLE_CALENDAR_METHODS = {
  create: 'calendar.create',
  delete: 'calendar.delete',
  events: 'calendar.events',
  listCalendars: 'calendar.listCalendars',
  move: 'calendar.move',
  requestAccess: 'calendar.requestAccess',
  series: 'calendar.series',
  setColor: 'calendar.setColor',
  status: 'calendar.status',
  update: 'calendar.update',
} as const;
