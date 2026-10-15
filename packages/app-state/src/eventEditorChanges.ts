import {
  geoMatches,
  GeoLocation,
  type AttendeeInput,
  type DraftEventTimes,
  type EventReminders,
  type UpdateEventChanges,
} from '@calendar/core';

/**
 * The coordinates Save writes for `location`: only ones the user vouched
 * for — the event's own (mirrored) ones or a picked suggestion — and only
 * while they match the text being saved. The open-time lookup of free
 * text stays on this device: MapKit's guess for "Room 4B" must not become
 * every device's truth.
 */
export const vouchedGeo = (
  geo: GeoLocation | undefined,
  location: string,
): GeoLocation | undefined =>
  geoMatches(geo, location) ? new GeoLocation({ ...geo, source: location }) : undefined;

/** The editor's text fields in their submitted form (trimmed), and the coordinates it holds. */
export interface EventEditorText {
  readonly description: string;
  /** Compared by identity: only a picked place (or a thread's draft) replaces them. */
  readonly geo: GeoLocation | undefined;
  readonly location: string;
  readonly title: string;
}

/**
 * What Save sends for an existing event: only what differs from what the
 * editor opened with. An event is edited from elsewhere too — another
 * device, an agent through the gateway, Google itself — and sync lands
 * those edits in the row while the form is open; resending an untouched
 * field would overwrite such an edit with the value the form was seeded
 * with. The text is compared against the *opening* snapshot, never the
 * live row: a field the user never touched stays untouched whatever
 * happened to it meanwhile. An untouched Save is `{}`, and writes nothing.
 *
 * The location and its coordinates go together (null clears stale ones),
 * so the mutation's `withConsistentGeo` always judges a pair the user
 * saw. The rest arrive already filtered by the form's own dirty flags:
 * undefined leaves the field alone. The kind (`isAllDay`) rides with the
 * times, so the times are read as what they are and a kind changed
 * elsewhere is not switched back.
 */
export const eventEditorChanges = ({
  attendees,
  current,
  initial,
  recurrence,
  reminders,
  times,
}: {
  /** The guest list, once edited. */
  readonly attendees: ReadonlyArray<AttendeeInput> | undefined;
  readonly current: EventEditorText;
  readonly initial: EventEditorText;
  /** A series' rule, once edited: lines for a new one, null for "does not repeat". */
  readonly recurrence: ReadonlyArray<string> | null | undefined;
  readonly reminders: EventReminders | undefined;
  /** The times, when the update sends them (`updateSendsTimes`). */
  readonly times: (DraftEventTimes & { readonly isAllDay: boolean }) | undefined;
}): typeof UpdateEventChanges.Type => ({
  ...(attendees === undefined ? {} : { attendees }),
  ...(current.description === initial.description ? {} : { description: current.description }),
  // Empty text clears the location; undefined would read as "unchanged".
  ...(current.location === initial.location && current.geo === initial.geo
    ? {}
    : { geo: vouchedGeo(current.geo, current.location) ?? null, location: current.location }),
  ...(recurrence === undefined ? {} : { recurrence }),
  ...(reminders === undefined ? {} : { reminders }),
  ...(current.title === initial.title ? {} : { title: current.title }),
  ...times,
});
