import {
  buildRecurrenceRule,
  buildEventTimes,
  meetingUrl,
  toZonedDateTime,
  validateEventDraft,
  type Attendee,
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

/** What an editor is opened with: an existing event, or a prefilled slot. */
export interface EventEditorSeed {
  readonly event?: EventRecord;
  readonly initialDate: Temporal.PlainDate;
  readonly initialHour?: number;
}

export type RepeatEnds = 'after' | 'never' | 'on';

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

  const [title, setTitle] = useState(existing?.title ?? '');
  const [calendarKey, setCalendarKey] = useState(
    existing
      ? `${existing.accountId}:${existing.calendarId}`
      : writableCalendars[0]
        ? `${writableCalendars[0].accountId}:${writableCalendars[0].id}`
        : '',
  );
  const [isAllDay, setIsAllDay] = useState(existing?.isAllDay ?? false);
  const [date, setDate] = useState(
    existing
      ? (existing.startDate ??
          toZonedDateTime(existing.startUtc, timeZone).toPlainDate().toString())
      : seed.initialDate.toString(),
  );
  const [startTime, setStartTime] = useState(
    existing && !existing.isAllDay
      ? timeString(existing.startUtc, timeZone)
      : pad(seed.initialHour ?? 9),
  );
  const [endTime, setEndTime] = useState(
    existing && !existing.isAllDay
      ? timeString(existing.endUtc, timeZone)
      : pad((seed.initialHour ?? 9) + 1),
  );
  const [location, setLocation] = useState(existing?.location ?? '');
  const [scope, setScope] = useState<RecurringScope>('instance');
  const [rsvp, setRsvp] = useState(ownAttendee?.responseStatus);
  const [repeat, setRepeat] = useState<RecurrenceFrequency | 'none'>('none');
  const [repeatInterval, setRepeatInterval] = useState('1');
  const [repeatEnds, setRepeatEnds] = useState<RepeatEnds>('never');
  const [repeatCount, setRepeatCount] = useState('10');
  const [repeatUntil, setRepeatUntil] = useState('');
  const [error, setError] = useState<string | null>(null);

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
          calendarId,
          isAllDay,
          location: location.trim() || undefined,
          recurrence:
            repeat === 'none'
              ? undefined
              : [
                  buildRecurrenceRule(
                    {
                      count: repeatEnds === 'after' ? Number(repeatCount) || 1 : undefined,
                      freq: repeat,
                      interval: Number(repeatInterval) || 1,
                      untilDate: repeatEnds === 'on' && repeatUntil ? repeatUntil : undefined,
                    },
                    isAllDay,
                  ),
                ],
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
    repeat,
    repeatCount,
    repeatEnds,
    repeatInterval,
    repeatUntil,
    respond,
    rsvp,
    save,
    scope,
    setCalendarKey,
    setDate,
    setEndTime,
    setIsAllDay,
    setLocation,
    setRepeat,
    setRepeatCount,
    setRepeatEnds,
    setRepeatInterval,
    setRepeatUntil,
    setScope,
    setStartTime,
    setTitle,
    startTime,
    title,
    writableCalendars,
  };
};
