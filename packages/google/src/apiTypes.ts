import { Schema } from 'effect';

/** Google's event time: exactly one of `date` (all-day) or `dateTime` is set. */
export const GcalTime = Schema.Struct({
  date: Schema.optional(Schema.String),
  dateTime: Schema.optional(Schema.String),
  timeZone: Schema.optional(Schema.String),
});

export const GcalAttendee = Schema.Struct({
  displayName: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  organizer: Schema.optional(Schema.Boolean),
  resource: Schema.optional(Schema.Boolean),
  responseStatus: Schema.optional(Schema.String),
  self: Schema.optional(Schema.Boolean),
});

export const GcalEvent = Schema.Struct({
  attendees: Schema.optional(Schema.Array(GcalAttendee)),
  description: Schema.optional(Schema.String),
  end: Schema.optional(GcalTime),
  etag: Schema.optional(Schema.String),
  id: Schema.String,
  location: Schema.optional(Schema.String),
  organizer: Schema.optional(
    Schema.Struct({
      displayName: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
      self: Schema.optional(Schema.Boolean),
    }),
  ),
  originalStartTime: Schema.optional(GcalTime),
  recurrence: Schema.optional(Schema.Array(Schema.String)),
  recurringEventId: Schema.optional(Schema.String),
  start: Schema.optional(GcalTime),
  status: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  updated: Schema.optional(Schema.String),
});
export type GcalEvent = Schema.Schema.Type<typeof GcalEvent>;

export const GcalEventsPage = Schema.Struct({
  items: Schema.optional(Schema.Array(GcalEvent)),
  nextPageToken: Schema.optional(Schema.String),
  nextSyncToken: Schema.optional(Schema.String),
  timeZone: Schema.optional(Schema.String),
});
export type GcalEventsPage = Schema.Schema.Type<typeof GcalEventsPage>;

export const GcalCalendarListEntry = Schema.Struct({
  accessRole: Schema.optional(Schema.String),
  backgroundColor: Schema.optional(Schema.String),
  colorId: Schema.optional(Schema.String),
  deleted: Schema.optional(Schema.Boolean),
  id: Schema.String,
  primary: Schema.optional(Schema.Boolean),
  selected: Schema.optional(Schema.Boolean),
  summary: Schema.optional(Schema.String),
  summaryOverride: Schema.optional(Schema.String),
  timeZone: Schema.optional(Schema.String),
});
export type GcalCalendarListEntry = Schema.Schema.Type<typeof GcalCalendarListEntry>;

export const GcalCalendarListPage = Schema.Struct({
  items: Schema.optional(Schema.Array(GcalCalendarListEntry)),
  nextPageToken: Schema.optional(Schema.String),
  nextSyncToken: Schema.optional(Schema.String),
});
export type GcalCalendarListPage = Schema.Schema.Type<typeof GcalCalendarListPage>;

export const GcalColors = Schema.Struct({
  calendar: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        background: Schema.String,
        foreground: Schema.String,
      }),
    ),
  ),
});
export type GcalColors = Schema.Schema.Type<typeof GcalColors>;

/** Fields we send on events.insert / events.patch. */
export interface GcalEventInput {
  readonly description?: string | undefined;
  readonly end: {
    date?: string | undefined;
    dateTime?: string | undefined;
    timeZone?: string | undefined;
  };
  readonly id?: string | undefined;
  readonly location?: string | undefined;
  readonly start: {
    date?: string | undefined;
    dateTime?: string | undefined;
    timeZone?: string | undefined;
  };
  readonly summary: string;
}
