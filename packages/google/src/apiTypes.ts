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

const GcalConferenceData = Schema.Struct({
  entryPoints: Schema.optional(
    Schema.Array(
      Schema.Struct({
        entryPointType: Schema.optional(Schema.String),
        uri: Schema.optional(Schema.String),
      }),
    ),
  ),
});

/**
 * App-owned key/values. `private` is visible only on this calendar's copy
 * of the event; the app stores derived location coordinates there.
 */
const GcalExtendedProperties = Schema.Struct({
  private: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  shared: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

/** Google's per-event reminders; `overrides` is absent when `useDefault` is true. */
export const GcalReminders = Schema.Struct({
  overrides: Schema.optional(
    Schema.Array(Schema.Struct({ method: Schema.String, minutes: Schema.Number })),
  ),
  useDefault: Schema.Boolean,
});
export type GcalReminders = Schema.Schema.Type<typeof GcalReminders>;

export const GcalEvent = Schema.Struct({
  attendees: Schema.optional(Schema.Array(GcalAttendee)),
  conferenceData: Schema.optional(GcalConferenceData),
  description: Schema.optional(Schema.String),
  end: Schema.optional(GcalTime),
  etag: Schema.optional(Schema.String),
  extendedProperties: Schema.optional(GcalExtendedProperties),
  hangoutLink: Schema.optional(Schema.String),
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
  reminders: Schema.optional(GcalReminders),
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
  /** What an event's `reminders.useDefault` resolves to. */
  defaultReminders: Schema.optional(
    Schema.Array(Schema.Struct({ method: Schema.String, minutes: Schema.Number })),
  ),
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
  readonly attendees?:
    | ReadonlyArray<{
        readonly displayName?: string | undefined;
        readonly email: string;
        readonly resource?: boolean | undefined;
        readonly responseStatus?: string | undefined;
      }>
    | undefined;
  readonly description?: string | undefined;
  readonly end: {
    date?: string | undefined;
    dateTime?: string | undefined;
    timeZone?: string | undefined;
  };
  /**
   * Private keys only. PATCH merges keys into the stored map; a key is
   * deleted by sending it as null.
   */
  readonly extendedProperties?:
    | { readonly private?: Readonly<Record<string, string | null>> | undefined }
    | undefined;
  readonly id?: string | undefined;
  readonly location?: string | undefined;
  readonly recurrence?: ReadonlyArray<string> | undefined;
  /** PATCH replaces the whole object, so it always carries every override. */
  readonly reminders?:
    | {
        readonly overrides: ReadonlyArray<{ readonly method: string; readonly minutes: number }>;
        readonly useDefault: boolean;
      }
    | undefined;
  readonly start: {
    date?: string | undefined;
    dateTime?: string | undefined;
    timeZone?: string | undefined;
  };
  readonly summary: string;
}

/** start/end in a PATCH: Google merges the fields into the stored time; null removes one. */
export interface GcalTimePatch {
  readonly date?: string | null | undefined;
  readonly dateTime?: string | null | undefined;
  readonly timeZone?: string | null | undefined;
}

/** An events.patch body: any insert field, with times that can null the unused form. */
export type GcalEventPatch = Omit<Partial<GcalEventInput>, 'end' | 'start'> & {
  readonly end?: GcalTimePatch | undefined;
  readonly start?: GcalTimePatch | undefined;
};

export const GcalTaskList = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  updated: Schema.optional(Schema.String),
});
export type GcalTaskList = Schema.Schema.Type<typeof GcalTaskList>;

export const GcalTaskListsPage = Schema.Struct({
  items: Schema.optional(Schema.Array(GcalTaskList)),
  nextPageToken: Schema.optional(Schema.String),
});
export type GcalTaskListsPage = Schema.Schema.Type<typeof GcalTaskListsPage>;

export const GcalTask = Schema.Struct({
  completed: Schema.optional(Schema.String),
  deleted: Schema.optional(Schema.Boolean),
  due: Schema.optional(Schema.String),
  hidden: Schema.optional(Schema.Boolean),
  id: Schema.String,
  notes: Schema.optional(Schema.String),
  parent: Schema.optional(Schema.String),
  position: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  updated: Schema.optional(Schema.String),
  webViewLink: Schema.optional(Schema.String),
});
export type GcalTask = Schema.Schema.Type<typeof GcalTask>;

export const GcalTasksPage = Schema.Struct({
  items: Schema.optional(Schema.Array(GcalTask)),
  nextPageToken: Schema.optional(Schema.String),
});
export type GcalTasksPage = Schema.Schema.Type<typeof GcalTasksPage>;

/** People API person, trimmed to the fields the contacts cache reads. */
export const GcalPerson = Schema.Struct({
  /** Connections only (otherContacts.list rejects the field). `year` is absent or 0 when unknown. */
  birthdays: Schema.optional(
    Schema.Array(
      Schema.Struct({
        date: Schema.optional(
          Schema.Struct({
            day: Schema.optional(Schema.Number),
            month: Schema.optional(Schema.Number),
            year: Schema.optional(Schema.Number),
          }),
        ),
        metadata: Schema.optional(Schema.Struct({ primary: Schema.optional(Schema.Boolean) })),
        /** Free text ("March 4") when the contact has no structured date. */
        text: Schema.optional(Schema.String),
      }),
    ),
  ),
  emailAddresses: Schema.optional(
    Schema.Array(
      Schema.Struct({
        metadata: Schema.optional(Schema.Struct({ primary: Schema.optional(Schema.Boolean) })),
        value: Schema.optional(Schema.String),
      }),
    ),
  ),
  /** `deleted: true` on incremental syncs marks a tombstone. */
  metadata: Schema.optional(Schema.Struct({ deleted: Schema.optional(Schema.Boolean) })),
  names: Schema.optional(
    Schema.Array(
      Schema.Struct({
        displayName: Schema.optional(Schema.String),
        metadata: Schema.optional(Schema.Struct({ primary: Schema.optional(Schema.Boolean) })),
      }),
    ),
  ),
  resourceName: Schema.String,
});
export type GcalPerson = Schema.Schema.Type<typeof GcalPerson>;

/** people.connections.list (`connections`) and otherContacts.list (`otherContacts`) share paging. */
export const GcalPeoplePage = Schema.Struct({
  connections: Schema.optional(Schema.Array(GcalPerson)),
  nextPageToken: Schema.optional(Schema.String),
  nextSyncToken: Schema.optional(Schema.String),
  otherContacts: Schema.optional(Schema.Array(GcalPerson)),
});
export type GcalPeoplePage = Schema.Schema.Type<typeof GcalPeoplePage>;
