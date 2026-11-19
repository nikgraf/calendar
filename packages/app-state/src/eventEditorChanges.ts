import {
  canonicalReminders,
  emailKey,
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

/**
 * Notifications as what they mean: the calendar's default (which an
 * untouched new event has too), or the offsets in their stored form. Two
 * values that notify alike have the same key.
 */
export const remindersKey = (reminders: EventReminders | undefined): string =>
  reminders === undefined || reminders.useDefault
    ? 'default'
    : canonicalReminders(reminders)
        .overrides.map((override) => `${override.method}:${String(override.minutes)}`)
        .join(',');

/** A guest list by its addresses; the order they were added in says nothing. */
export const guestsKey = (attendees: ReadonlyArray<{ readonly email: string }>): string =>
  attendees
    .map((attendee) => emailKey(attendee.email))
    .sort()
    .join('\n');

/** The same place: none on both sides, or the same point under the same name. */
const sameGeo = (one: GeoLocation | undefined, other: GeoLocation | undefined): boolean =>
  one === undefined || other === undefined
    ? one === other
    : one.lat === other.lat && one.lng === other.lng && one.name === other.name;

/**
 * What the form holds of an event beyond its times and rule, in submitted
 * form (text trimmed): what an update compares with the form as it opened.
 */
export interface EventEditorValues {
  readonly attendees: ReadonlyArray<AttendeeInput>;
  readonly description: string;
  /** Counted only while they match `location` (`vouchedGeo`). */
  readonly geo: GeoLocation | undefined;
  readonly location: string;
  readonly reminders: EventReminders;
  readonly title: string;
}

/**
 * What Save sends for an existing event: only what differs from what the
 * editor opened with. An event is edited from elsewhere too — another
 * device, an agent through the gateway, Google itself — and sync lands
 * those edits in the row while the form is open; resending an untouched
 * field would overwrite such an edit with the value the form was seeded
 * with. Everything is compared against the *opening* snapshot, never the
 * live row: a field the user never touched stays untouched whatever
 * happened to it meanwhile. An untouched Save is `{}`, and writes nothing.
 *
 * Compared by value, not by a flag an edit sets: a guest added and taken
 * off again, a notification changed and changed back, or a draft that
 * left the form for a thread and came back the same is no change. The
 * guests are compared by address, the notifications as what they mean
 * (`remindersKey`), the coordinates as the ones Save would vouch for.
 *
 * The location and its coordinates go together (null clears stale ones),
 * so the mutation's `withConsistentGeo` always judges a pair the user
 * saw. The rule and the times arrive decided by the form (its scope has
 * a say): undefined leaves them alone. The kind (`isAllDay`) rides with
 * the times, so the times are read as what they are and a kind changed
 * elsewhere is not switched back.
 */
export const eventEditorChanges = ({
  current,
  initial,
  recurrence,
  times,
}: {
  readonly current: EventEditorValues;
  readonly initial: EventEditorValues;
  /** A series' rule, once changed: lines for a new one, null for "does not repeat". */
  readonly recurrence: ReadonlyArray<string> | null | undefined;
  /** The times, when the update sends them (`updateSendsTimes`). */
  readonly times: (DraftEventTimes & { readonly isAllDay: boolean }) | undefined;
}): typeof UpdateEventChanges.Type => ({
  ...(guestsKey(current.attendees) === guestsKey(initial.attendees)
    ? {}
    : { attendees: current.attendees }),
  ...(current.description === initial.description ? {} : { description: current.description }),
  // Empty text clears the location; undefined would read as "unchanged".
  ...(current.location === initial.location &&
  sameGeo(vouchedGeo(current.geo, current.location), vouchedGeo(initial.geo, initial.location))
    ? {}
    : { geo: vouchedGeo(current.geo, current.location) ?? null, location: current.location }),
  ...(recurrence === undefined ? {} : { recurrence }),
  ...(remindersKey(current.reminders) === remindersKey(initial.reminders)
    ? {}
    : { reminders: current.reminders }),
  ...(current.title === initial.title ? {} : { title: current.title }),
  ...times,
});
