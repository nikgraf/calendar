import {
  APPLE_CALENDAR_ACCOUNT_ID,
  Attendee,
  CalendarInfo,
  canonicalReminders,
  type EventDraft,
  EventRecord,
  EventReminders,
  GeoLocation,
  type UpdateEventChanges,
  meetingUrl,
  ReminderOverride,
  normalizeHexColor,
  plainDateToUtcMs,
  toStructuredRules,
  withConsistentGeo,
} from '@calendar/core';
import type { AppleCalendarJson, AppleEventJson, EventWrite } from './protocol.ts';

/** Fallback when EventKit reports no color (it always does in practice). */
const DEFAULT_COLOR = '#1badf8';

export const mapAppleCalendar = (
  calendar: AppleCalendarJson,
  context: { readonly deviceTimeZone: string; readonly previousVisibility?: boolean | undefined },
): CalendarInfo =>
  new CalendarInfo({
    accessRole: calendar.allowsModifications ? 'owner' : 'reader',
    accountId: APPLE_CALENDAR_ACCOUNT_ID,
    colorHex: normalizeHexColor(calendar.colorHex ?? '') ?? DEFAULT_COLOR,
    id: calendar.id,
    isPrimary: calendar.isDefault,
    isVisible: context.previousVisibility ?? true,
    provider: 'apple',
    // The bridge sends '' for a source without a title: absent, so UIs
    // can fall back with `??`.
    sourceTitle: calendar.sourceTitle || undefined,
    summary: calendar.title === '' ? '(untitled)' : calendar.title,
    timeZone: context.deviceTimeZone,
  });

/**
 * The record id of an Apple event. A single event keeps EventKit's
 * `eventIdentifier`; an occurrence of a series is `<id>__<occurrence
 * slot>` — the same shape assembleWindow gives Google occurrences — so
 * each occurrence is distinct in the UI and stable when it is moved on
 * its own (the slot, not its current start, names it).
 */
export const appleEventRecordId = (event: {
  readonly id: string;
  readonly occurrenceStartUtc?: number | undefined;
}): string =>
  event.occurrenceStartUtc === undefined ? event.id : `${event.id}__${event.occurrenceStartUtc}`;

export const mapAppleEvent = (
  event: AppleEventJson,
  context: { readonly deviceTimeZone: string; readonly now: number },
): EventRecord => {
  const url = event.url?.trim();
  const isOccurrence = event.occurrenceStartUtc !== undefined;
  const attendees = (event.attendees ?? []).map(
    (attendee) =>
      new Attendee({
        ...(attendee.name === undefined ? {} : { displayName: attendee.name }),
        email: attendee.email,
        ...(attendee.isOrganizer ? { isOrganizer: true } : {}),
        ...(attendee.isSelf ? { isSelf: true } : {}),
        responseStatus: attendee.status,
      }),
  );
  // EventKit usually leaves the organizer out of `attendees`; the
  // synthetic account has no email to match against, so the organizer's
  // own entry is what says "this is ours" (moves need that).
  if (
    event.organizerIsSelf &&
    event.organizerEmail &&
    !attendees.some((attendee) => attendee.isOrganizer && attendee.isSelf)
  ) {
    attendees.push(
      new Attendee({
        email: event.organizerEmail,
        isOrganizer: true,
        isSelf: true,
        responseStatus: 'accepted',
      }),
    );
  }
  const record = new EventRecord({
    accountId: APPLE_CALENDAR_ACCOUNT_ID,
    attendees: attendees.length > 0 ? attendees : undefined,
    calendarId: event.calendarId,
    description: event.description,
    endDate: event.isAllDay ? event.endDate : undefined,
    endUtc: event.isAllDay && event.endDate ? plainDateToUtcMs(event.endDate) : event.endUtc,
    etag: null,
    geo:
      event.geo && event.location
        ? new GeoLocation({ ...event.geo, source: event.location })
        : undefined,
    hangoutLink: url && meetingUrl({ location: url }) === url ? url : undefined,
    id: appleEventRecordId(event),
    isAllDay: event.isAllDay,
    location: event.location,
    organizerEmail: event.organizerEmail,
    originalStartUtc: isOccurrence ? event.occurrenceStartUtc : undefined,
    recurringEventId: isOccurrence ? event.id : undefined,
    reminders: fromAlarms(event.alarms),
    startDate: event.isAllDay ? event.startDate : undefined,
    // A floating event reads in the device's zone, like Calendar.app shows it.
    startTimeZone: event.isAllDay ? undefined : (event.timeZone ?? context.deviceTimeZone),
    startUtc:
      event.isAllDay && event.startDate ? plainDateToUtcMs(event.startDate) : event.startUtc,
    status: event.status,
    syncedAt: context.now,
    syncStatus: 'synced',
    title: event.title === '' ? '(no title)' : event.title,
    updatedAt: event.updatedAt,
  });
  return withConsistentGeo(record);
};

const geoWrite = (geo: GeoLocation | null | undefined): EventWrite['geo'] =>
  geo === null
    ? null
    : geo === undefined
      ? undefined
      : { lat: geo.lat, lng: geo.lng, ...(geo.name === undefined ? {} : { name: geo.name }) };

/**
 * EventKit alarms as the domain sees them: always explicit (EventKit has
 * no "calendar default"), popup only, minutes-before positive. Alarms
 * after the start (a positive EventKit offset) are dropped — nothing
 * here can show them.
 */
const fromAlarms = (alarms: ReadonlyArray<number> | undefined): EventReminders =>
  canonicalReminders(
    new EventReminders({
      overrides: (alarms ?? [])
        .filter((offset) => offset <= 0)
        .map((offset) => new ReminderOverride({ method: 'popup', minutes: -offset })),
      useDefault: false,
    }),
  );

/** The popup reminders as EventKit offsets. The mutation layer rejected `useDefault` and email ones. */
const toAlarms = (reminders: EventReminders): Array<number> =>
  canonicalReminders(reminders)
    .overrides.filter((override) => override.method === 'popup')
    .map((override) => -override.minutes || 0);

/** An emptied text field clears it; undefined leaves it alone. */
const clearable = (value: string | undefined): string | null | undefined =>
  value === undefined ? undefined : value.trim() === '' ? null : value;

/**
 * An edit as the bridge takes it. Guests never reach here (EventKit
 * cannot write them; the mutation layer rejects them first). A changed
 * location without coordinates drops the stored ones on the Swift side.
 */
export const toEventWrite = (changes: typeof UpdateEventChanges.Type): EventWrite => ({
  ...(changes.reminders === undefined ? {} : { alarms: toAlarms(changes.reminders) }),
  ...(changes.description === undefined ? {} : { description: clearable(changes.description) }),
  ...(changes.endDate === undefined ? {} : { endDate: changes.endDate }),
  ...(changes.endUtc === undefined ? {} : { endUtc: changes.endUtc }),
  ...(changes.geo === undefined ? {} : { geo: geoWrite(changes.geo) }),
  ...(changes.isAllDay === undefined ? {} : { isAllDay: changes.isAllDay }),
  ...(changes.location === undefined ? {} : { location: clearable(changes.location) }),
  ...(changes.startDate === undefined ? {} : { startDate: changes.startDate }),
  ...(changes.startUtc === undefined ? {} : { startUtc: changes.startUtc }),
  ...(changes.title === undefined ? {} : { title: changes.title }),
});

/**
 * A new event as the bridge takes it, or the recurrence parts EventKit
 * cannot store (the caller refuses the create rather than silently
 * writing a different series).
 */
export const draftToEventWrite = (
  draft: EventDraft,
  deviceTimeZone: string,
):
  | { readonly _tag: 'ok'; readonly write: EventWrite }
  | { readonly _tag: 'unsupported'; readonly parts: ReadonlyArray<string> } => {
  const zone = draft.startTimeZone ?? deviceTimeZone;
  const structured = draft.recurrence
    ? toStructuredRules(draft.recurrence, draft.isAllDay, zone)
    : undefined;
  if (structured && structured.unsupported.length > 0) {
    return { _tag: 'unsupported', parts: structured.unsupported };
  }
  const location = draft.location?.trim();
  return {
    _tag: 'ok',
    write: {
      ...(draft.reminders ? { alarms: toAlarms(draft.reminders) } : {}),
      ...(draft.description ? { description: draft.description } : {}),
      endUtc: draft.endUtc,
      ...(draft.isAllDay ? { endDate: draft.endDate, startDate: draft.startDate } : {}),
      ...(draft.geo && location ? { geo: geoWrite(draft.geo) } : {}),
      isAllDay: draft.isAllDay,
      ...(location ? { location } : {}),
      ...(structured && structured.rules.length > 0 ? { recurrence: structured.rules } : {}),
      startUtc: draft.startUtc,
      ...(draft.isAllDay ? {} : { timeZone: zone }),
      title: draft.title,
      ...(draft.url ? { url: draft.url } : {}),
    },
  };
};
