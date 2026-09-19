import {
  buildRecurrenceRule,
  buildEventTimes,
  emailKey,
  geoMatches,
  isMappableLocation,
  meetingUrl,
  openInMapsUrl,
  placeSuggestionLabel,
  toZonedDateTime,
  validateEventDraft,
  type Attendee,
  type AttendeeInput,
  type CalendarInfo,
  type EventDraft,
  type EventRecord,
  type GeoLocation,
  type PlaceSuggestion,
  type RecurrenceFrequency,
  type RecurringScope,
  type RsvpResponse,
  type Temporal,
} from '@calendar/core';
import { useState } from 'react';
import { useAccounts, useBackendMutations, useLocationGeo } from './hooks.ts';
import { useRepeatState } from './repeatState.ts';

/**
 * Fields a parsed phrase can prefill. Structural on purpose so app-state
 * stays independent of the AI package.
 */
export type { RepeatEnds } from './repeatState.ts';

export interface EventEditorPrefill {
  readonly date: string;
  readonly endTime: string;
  readonly isAllDay: boolean;
  readonly location?: string;
  readonly recurrence?: {
    readonly count?: number;
    readonly freq: RecurrenceFrequency;
    readonly interval?: number;
    readonly untilDate?: string;
  };
  readonly startTime: string;
  readonly title: string;
}

/** What an editor is opened with: an existing event, or a prefilled slot. */
export interface EventEditorSeed {
  /** `accountId:calendarId` to create in; wins over the remembered calendar. */
  readonly calendarKey?: string | undefined;
  readonly event?: EventRecord;
  readonly initialDate: Temporal.PlainDate;
  readonly initialHour?: number;
  /** A slot drawn on the time grid (`HH:MM`); wins over `initialHour`. */
  readonly initialTimes?: { readonly endTime: string; readonly startTime: string };
  /** Quick-add result: the user reviews it before anything is written. */
  readonly prefill?: EventEditorPrefill;
}

/**
 * The calendar the last event was created in, for this session. A new
 * event used to default to the first writable calendar every time, so a
 * user whose primary calendar is not first kept re-picking it.
 */
let lastUsedCalendarKey: string | null = null;
export const rememberCalendar = (calendarKey: string): void => {
  lastUsedCalendarKey = calendarKey;
};

const pad = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;

/**
 * The start and end a new event opens with: a quick-add result first, then
 * a slot drawn on the grid, then the clicked hour (one hour long), then 09:00.
 */
export const seedTimeFields = (seed: EventEditorSeed): { endTime: string; startTime: string } => ({
  endTime: seed.prefill?.endTime ?? seed.initialTimes?.endTime ?? pad((seed.initialHour ?? 9) + 1),
  startTime: seed.prefill?.startTime ?? seed.initialTimes?.startTime ?? pad(seed.initialHour ?? 9),
});

const timeString = (epochMs: number, timeZone: string): string =>
  toZonedDateTime(epochMs, timeZone).toPlainTime().toString({ smallestUnit: 'minute' });

/**
 * Everything the event editors do that isn't JSX: field state, validation,
 * and the create/update/delete/RSVP calls. Desktop and iOS share it so the
 * two UIs can't drift apart in behaviour.
 */
export const useEventEditorModel = ({
  calendars,
  onClose,
  seed,
  timeZone,
}: {
  calendars: ReadonlyArray<CalendarInfo>;
  onClose: () => void;
  seed: EventEditorSeed;
  timeZone: string;
}) => {
  const mutations = useBackendMutations();
  const accounts = useAccounts();
  const existing = seed.event;
  const isRecurring = Boolean(existing && (existing.recurrence || existing.recurringEventId));
  const ownEmail = accounts
    .find((account) => account.id === existing?.accountId)
    ?.email.toLowerCase();
  const ownAttendee: Attendee | undefined = existing?.attendees?.find(
    (attendee) => attendee.isSelf === true || attendee.email.toLowerCase() === ownEmail,
  );
  const joinUrl = existing ? meetingUrl(existing) : undefined;
  const writableCalendars = calendars.filter(
    (calendar) => calendar.accessRole === 'owner' || calendar.accessRole === 'writer',
  );

  const prefill = seed.prefill;
  const [title, setTitle] = useState(existing?.title ?? prefill?.title ?? '');
  const [calendarKey, setCalendarKey] = useState(() => {
    if (existing) {
      return `${existing.accountId}:${existing.calendarId}`;
    }
    const writableKeys = writableCalendars.map(
      (calendar) => `${calendar.accountId}:${calendar.id}`,
    );
    const preferred = [seed.calendarKey, lastUsedCalendarKey].find(
      (key): key is string => key !== undefined && key !== null && writableKeys.includes(key),
    );
    return preferred ?? writableKeys[0] ?? '';
  });
  const [isAllDay, setIsAllDay] = useState(existing?.isAllDay ?? prefill?.isAllDay ?? false);
  const [date, setDate] = useState(
    existing
      ? (existing.startDate ??
          toZonedDateTime(existing.startUtc, timeZone).toPlainDate().toString())
      : (prefill?.date ?? seed.initialDate.toString()),
  );
  const [startTime, setStartTime] = useState(
    existing && !existing.isAllDay
      ? timeString(existing.startUtc, timeZone)
      : seedTimeFields(seed).startTime,
  );
  const [endTime, setEndTime] = useState(
    existing && !existing.isAllDay
      ? timeString(existing.endUtc, timeZone)
      : seedTimeFields(seed).endTime,
  );
  const initialLocation = existing?.location ?? prefill?.location ?? '';
  const [location, setLocation] = useState(initialLocation);
  // Coordinates for the location text, from the event (server-mirrored) or
  // a picked suggestion. Never cleared on typing: they count only while
  // geoMatches, so retyping the original text brings the map back.
  const [geo, setGeo] = useState<GeoLocation | undefined>(existing?.geo);
  const [picking, setPicking] = useState(false);
  // Text the editor was opened with and has no coordinates for (an event
  // from before this feature, another client's edit, a quick-add
  // location): geocoded once on open. Typing never geocodes — the picker
  // does that — so an edit away from the opening text stops the lookup.
  const lookupLocation =
    location === initialLocation && !geoMatches(geo, location) && isMappableLocation(location)
      ? location
      : '';
  const lookup = useLocationGeo(lookupLocation);
  const mapGeo = geoMatches(geo, location)
    ? geo
    : lookupLocation !== '' && geoMatches(lookup.geo ?? undefined, location)
      ? (lookup.geo ?? undefined)
      : undefined;
  const mapLoading = picking || (lookupLocation !== '' && lookup.loading);
  // The guest list as the editor shows it; `attendeesDirty` keeps an
  // untouched list out of the update (undefined = unchanged upstream).
  const [attendees, setAttendees] = useState<ReadonlyArray<AttendeeInput>>(() =>
    (existing?.attendees ?? [])
      // Rooms are not guests: hidden here, carried over by mergeAttendees.
      .filter((attendee) => !attendee.isResource)
      .map((attendee) => ({ displayName: attendee.displayName, email: attendee.email })),
  );
  const [attendeesDirty, setAttendeesDirty] = useState(false);
  const [scope, setScope] = useState<RecurringScope>('instance');
  const [rsvp, setRsvp] = useState(ownAttendee?.responseStatus);
  const { toSpec: repeatSpec, ...repeatState } = useRepeatState(prefill?.recurrence);
  const [error, setError] = useState<string | null>(null);

  const addAttendee = (input: AttendeeInput): boolean => {
    const key = emailKey(input.email);
    if (key === '' || attendees.some((attendee) => emailKey(attendee.email) === key)) {
      return false;
    }
    setAttendees([...attendees, { displayName: input.displayName, email: input.email.trim() }]);
    setAttendeesDirty(true);
    return true;
  };

  const removeAttendee = (email: string) => {
    const key = emailKey(email);
    setAttendees(attendees.filter((attendee) => emailKey(attendee.email) !== key));
    setAttendeesDirty(true);
  };

  /**
   * A typeahead row was picked: its label becomes the location text and
   * MapKit resolves that exact place. A slow answer for an older pick is
   * harmless — coordinates only count while they match the current text.
   */
  const pickPlace = async (suggestion: PlaceSuggestion) => {
    const label = placeSuggestionLabel(suggestion);
    setLocation(label);
    setPicking(true);
    try {
      const resolved = await mutations.resolveLocation({ location: label, suggestion });
      if (resolved) {
        setGeo(resolved);
      }
    } catch {
      // No coordinates: the text is still a perfectly good location.
    } finally {
      setPicking(false);
    }
  };

  /** Server facts for a chip (response, organizer) — only for guests already on the event. */
  const attendeeStatus = (email: string): Attendee | undefined =>
    existing?.attendees?.find((attendee) => emailKey(attendee.email) === emailKey(email));

  const save = async () => {
    const fields = { calendarKey, date, endTime, isAllDay, startTime, title };
    const invalid = validateEventDraft(fields, timeZone);
    if (invalid) {
      setError(invalid);
      return;
    }
    const [accountId, calendarId] = calendarKey.split(':', 2) as [string, string];
    const times = buildEventTimes(fields, timeZone);
    // Only coordinates for the text being saved; an update sends null to
    // clear stale ones (the backend enforces the same rule regardless).
    const savedGeo = geoMatches(mapGeo, location.trim()) ? mapGeo : undefined;
    try {
      if (existing && isRecurring && existing.recurringEventId) {
        await mutations.updateRecurring({
          accountId,
          calendarId,
          changes: {
            ...(attendeesDirty ? { attendees } : {}),
            geo: savedGeo ?? null,
            // Empty string clears the field; undefined would read as "unchanged".
            location: location.trim(),
            title: title.trim(),
            ...times,
          },
          masterId: existing.recurringEventId,
          originalStartUtc: existing.originalStartUtc ?? existing.startUtc,
          scope,
        });
      } else if (existing) {
        await mutations.updateEvent({
          accountId,
          calendarId,
          changes: {
            ...(attendeesDirty ? { attendees } : {}),
            geo: savedGeo ?? null,
            isAllDay,
            location: location.trim(),
            title: title.trim(),
            ...times,
          },
          eventId: existing.id,
        });
      } else {
        const draft: EventDraft = {
          accountId,
          ...(attendees.length > 0 ? { attendees } : {}),
          calendarId,
          geo: savedGeo,
          isAllDay,
          location: location.trim() || undefined,
          recurrence: (() => {
            const spec = repeatSpec();
            return spec ? [buildRecurrenceRule(spec, isAllDay)] : undefined;
          })(),
          title: title.trim(),
          ...times,
        };
        await mutations.createEvent(draft);
        rememberCalendar(calendarKey);
      }
      onClose();
    } catch (error) {
      setError(String(error));
    }
  };

  const respond = async (response: RsvpResponse) => {
    if (!existing) {
      return;
    }
    setRsvp(response);
    try {
      // RSVP applies to the whole series when opened from an instance.
      await mutations.respondToEvent({
        accountId: existing.accountId,
        calendarId: existing.calendarId,
        eventId: existing.recurringEventId ?? existing.id,
        response,
      });
    } catch (error) {
      setError(String(error));
    }
  };

  const remove = async () => {
    if (!existing) {
      return;
    }
    try {
      if (isRecurring && existing.recurringEventId) {
        await mutations.deleteRecurring({
          accountId: existing.accountId,
          calendarId: existing.calendarId,
          masterId: existing.recurringEventId,
          originalStartUtc: existing.originalStartUtc ?? existing.startUtc,
          scope,
        });
      } else {
        await mutations.deleteEvent({
          accountId: existing.accountId,
          calendarId: existing.calendarId,
          eventId: existing.id,
        });
      }
      onClose();
    } catch (error) {
      setError(String(error));
    }
  };

  return {
    addAttendee,
    attendees,
    attendeeStatus,
    calendarKey,
    date,
    endTime,
    error,
    existing,
    isAllDay,
    isRecurring,
    joinUrl,
    location,
    /** Coordinates to map for the current text, if known. */
    mapGeo,
    mapLoading,
    /** Apple Maps link for the mapped place (https: routes to Maps on macOS and iOS). */
    mapsUrl: mapGeo ? openInMapsUrl(mapGeo) : undefined,
    ownAttendee,
    pickPlace,
    remove,
    removeAttendee,
    ...repeatState,
    respond,
    rsvp,
    save,
    scope,
    setCalendarKey,
    setDate,
    setEndTime,
    setIsAllDay,
    setLocation,
    setScope,
    setStartTime,
    setTitle,
    startTime,
    title,
    writableCalendars,
  };
};
