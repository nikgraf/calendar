import {
  buildRecurrenceRule,
  buildEventTimes,
  emailKey,
  meetingUrl,
  toZonedDateTime,
  validateEventDraft,
  type Attendee,
  type AttendeeInput,
  type CalendarInfo,
  type EventDraft,
  type EventRecord,
  type RecurrenceFrequency,
  type RecurringScope,
  type RsvpResponse,
  type Temporal,
} from '@calendar/core';
import { useState } from 'react';
import { useAccounts } from './hooks.ts';
import { useBackendMutations } from './hooks.ts';
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
  readonly event?: EventRecord;
  readonly initialDate: Temporal.PlainDate;
  readonly initialHour?: number;
  /** Quick-add result: the user reviews it before anything is written. */
  readonly prefill?: EventEditorPrefill;
}

const pad = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;

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
  const [calendarKey, setCalendarKey] = useState(
    existing
      ? `${existing.accountId}:${existing.calendarId}`
      : writableCalendars[0]
        ? `${writableCalendars[0].accountId}:${writableCalendars[0].id}`
        : '',
  );
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
      : (prefill?.startTime ?? pad(seed.initialHour ?? 9)),
  );
  const [endTime, setEndTime] = useState(
    existing && !existing.isAllDay
      ? timeString(existing.endUtc, timeZone)
      : (prefill?.endTime ?? pad((seed.initialHour ?? 9) + 1)),
  );
  const [location, setLocation] = useState(existing?.location ?? prefill?.location ?? '');
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
    try {
      if (existing && isRecurring && existing.recurringEventId) {
        await mutations.updateRecurring({
          accountId,
          calendarId,
          changes: {
            ...(attendeesDirty ? { attendees } : {}),
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
    ownAttendee,
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
