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
 *   being moved on its own, so with the series it names the occurrence.
 *   Present iff the event repeats or is a detached occurrence.
 * - `id` is EventKit's `eventIdentifier`, untouched: the series' for an
 *   occurrence the rule draws, `<series id>/RID=…` for one changed on its
 *   own (identity.ts). The bridge compares it literally. The client the
 *   app uses names every occurrence by its series (`withSeriesIdentity`).
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
   * Relative alarm offsets in minutes, EventKit sign, at or before the
   * start (≤ 0; all-day: before local midnight). Absolute-date alarms
   * and alarms after the start are neither listed nor touched, like the
   * Reminders protocol's absolute ones.
   */
  alarms: Schema.optional(Schema.Array(Schema.Number)),
  /** Read-only: EventKit cannot invite or change guests. */
  attendees: Schema.optional(Schema.Array(AppleAttendeeJson)),
  calendarId: Schema.String,
  description: Schema.optional(Schema.String),
  /** All-day only, exclusive. */
  endDate: Schema.optional(Schema.String),
  endUtc: Schema.Number,
  /**
   * EKCalendarItem.calendarItemExternalIdentifier: unlike `id`, the same on
   * every device the event syncs to. The occurrences a series draws share
   * it; one changed on its own has `<external id>/RID=…`, like its `id`,
   * and keeps it here under either client. A calendar mirror keys its
   * sources by it.
   */
  externalId: Schema.optional(Schema.String),
  geo: Schema.optional(AppleGeoJson),
  hasRecurrence: Schema.Boolean,
  /**
   * From the bridge: EKEvent.eventIdentifier, shared by the occurrences a
   * series draws; an occurrence changed on its own has one of its own.
   * From the client: the series' id for every occurrence.
   */
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
  /** Replaces the listed alarms (null = none); absolute and after-start ones stay. */
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

/**
 * A single event or a series as a whole (`originalStartUtc` absent: `id`
 * is EventKit's and names exactly that event), or one occurrence of a
 * series by the series' id and its slot.
 */
export interface OccurrenceRef {
  readonly id: string;
  readonly originalStartUtc?: number | undefined;
}

/**
 * How far either side of a slot the bridge looks for the event a ref by
 * slot names (`occurrence(id:originalStartUtc:)` in
 * AppleCalendarBridge.swift, the same overlap query `calendar.events`
 * runs). An occurrence the rule draws sits on its slot, so the bridge
 * always finds it. One changed on its own can sit any distance away, and
 * the bridge does not find it by the series' id at all: the client reads
 * it by its own identifier, or — where that no longer names the slot —
 * among what a range read this far around the slot returns
 * (`withSeriesIdentity`).
 */
export const APPLE_WRITE_REACH_MS = 31 * 24 * 60 * 60 * 1000;

/**
 * One write of `calendar.applyBatch`: single events only (span
 * `thisEvent`). A calendar mirror writes its copies this way — the whole
 * batch is one commit, so one change notification and nothing half-written.
 */
export type BatchWrite =
  | { readonly calendarId: string; readonly event: EventWrite; readonly kind: 'create' }
  | { readonly kind: 'delete'; readonly ref: OccurrenceRef }
  | { readonly changes: EventWrite; readonly kind: 'update'; readonly ref: OccurrenceRef };

/** The bridge refuses a larger batch; a caller with more work sends several. */
export const APPLE_BATCH_MAX = 200;

/** The writes that could not be made, by their index in the batch; the rest landed. */
export const ApplyBatchResult = Schema.Struct({
  failures: Schema.Array(Schema.Struct({ index: Schema.Number, message: Schema.String })),
});
export type ApplyBatchResult = typeof ApplyBatchResult.Type;

export const CreateCalendarResult = Schema.Struct({ calendar: AppleCalendarJson });

export const StatusResult = Schema.Struct({ authorization: CalendarAuthorization });
export const RequestAccessResult = Schema.Struct({ granted: Schema.Boolean });
export const ListCalendarsResult = Schema.Struct({ calendars: Schema.Array(AppleCalendarJson) });
export const EventsResult = Schema.Struct({ events: Schema.Array(AppleEventJson) });
export const EventResult = Schema.Struct({ event: AppleEventJson });
/**
 * `calendar.series`: the event `id` names — for a series its first
 * occurrence as the rule draws it, with its rules; for a single event or
 * an occurrence's own identifier that event, without rules.
 * `detachedCount` compares the series id with the identifiers of detached
 * occurrences, which never equal it: it is 0 on a real store and nothing
 * reads it (`countAppleChangedOccurrences` in packages/sync counts).
 */
export const SeriesResult = Schema.Struct({
  detachedCount: Schema.Number,
  first: AppleEventJson,
  rules: Schema.Array(StructuredRule),
});
export type SeriesResult = typeof SeriesResult.Type;

export const APPLE_CALENDAR_METHODS = {
  applyBatch: 'calendar.applyBatch',
  create: 'calendar.create',
  createCalendar: 'calendar.createCalendar',
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
