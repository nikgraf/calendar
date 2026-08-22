import { useAccounts, useBackendMutations } from '@calendar/app-state';
import {
  buildRecurrenceRule,
  meetingUrl,
  plainDateToUtcMs,
  Temporal,
  toZonedDateTime,
  type CalendarInfo,
  type EventDraft,
  type EventRecord,
  type RecurrenceFrequency,
  type RecurringScope,
  type RsvpResponse,
} from '@calendar/core';
import { useState } from 'react';

const RSVP_OPTIONS: ReadonlyArray<{ label: string; value: RsvpResponse }> = [
  { label: 'Accept', value: 'accepted' },
  { label: 'Maybe', value: 'tentative' },
  { label: 'Decline', value: 'declined' },
];

const REPEAT_OPTIONS: ReadonlyArray<{ label: string; value: RecurrenceFrequency | 'none' }> = [
  { label: 'Does not repeat', value: 'none' },
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Monthly', value: 'monthly' },
  { label: 'Yearly', value: 'yearly' },
];

const SCOPES: ReadonlyArray<{ label: string; value: RecurringScope }> = [
  { label: 'This event', value: 'instance' },
  { label: 'This and following', value: 'following' },
  { label: 'All events', value: 'series' },
];

export interface EditorSeed {
  /** Existing event (edit mode) or a prefilled slot (create mode). */
  readonly event?: EventRecord;
  readonly initialDate: Temporal.PlainDate;
  readonly initialHour?: number;
}

const toDateInput = (epochMs: number, timeZone: string): string =>
  toZonedDateTime(epochMs, timeZone).toPlainDate().toString();

const toTimeInput = (epochMs: number, timeZone: string): string =>
  toZonedDateTime(epochMs, timeZone).toPlainTime().toString({ smallestUnit: 'minute' });

const combine = (date: string, time: string, timeZone: string): number =>
  Temporal.PlainDate.from(date)
    .toZonedDateTime({ plainTime: Temporal.PlainTime.from(time), timeZone })
    .toInstant().epochMilliseconds;

export function EventEditor({
  calendars,
  onClose,
  seed,
  timeZone,
}: {
  calendars: ReadonlyArray<CalendarInfo>;
  onClose: () => void;
  seed: EditorSeed;
  timeZone: string;
}) {
  const mutations = useBackendMutations();
  const accounts = useAccounts();
  const existing = seed.event;
  const isRecurring = Boolean(existing && (existing.recurrence || existing.recurringEventId));
  const ownEmail = accounts
    .find((account) => account.id === existing?.accountId)
    ?.email.toLowerCase();
  const ownAttendee = existing?.attendees?.find(
    (attendee) => attendee.isSelf === true || attendee.email.toLowerCase() === ownEmail,
  );
  const joinUrl = existing ? meetingUrl(existing) : undefined;
  const writable = calendars.filter(
    (calendar) => calendar.accessRole === 'owner' || calendar.accessRole === 'writer',
  );

  const [title, setTitle] = useState(existing?.title ?? '');
  const [calendarKey, setCalendarKey] = useState(
    existing
      ? `${existing.accountId}:${existing.calendarId}`
      : writable[0]
        ? `${writable[0].accountId}:${writable[0].id}`
        : '',
  );
  const [isAllDay, setIsAllDay] = useState(existing?.isAllDay ?? false);
  const [date, setDate] = useState(
    existing
      ? (existing.startDate ?? toDateInput(existing.startUtc, timeZone))
      : seed.initialDate.toString(),
  );
  const [startTime, setStartTime] = useState(
    existing && !existing.isAllDay
      ? toTimeInput(existing.startUtc, timeZone)
      : `${String(seed.initialHour ?? 9).padStart(2, '0')}:00`,
  );
  const [endTime, setEndTime] = useState(
    existing && !existing.isAllDay
      ? toTimeInput(existing.endUtc, timeZone)
      : `${String((seed.initialHour ?? 9) + 1).padStart(2, '0')}:00`,
  );
  const [location, setLocation] = useState(existing?.location ?? '');
  const [scope, setScope] = useState<RecurringScope>('instance');
  const [rsvp, setRsvp] = useState(ownAttendee?.responseStatus);
  const [repeat, setRepeat] = useState<RecurrenceFrequency | 'none'>('none');
  const [repeatInterval, setRepeatInterval] = useState('1');
  const [repeatEnds, setRepeatEnds] = useState<'after' | 'never' | 'on'>('never');
  const [repeatCount, setRepeatCount] = useState('10');
  const [repeatUntil, setRepeatUntil] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const [accountId, calendarId] = calendarKey.split(':', 2);
    if (!accountId || !calendarId || !title.trim()) {
      setError('A title and calendar are required.');
      return;
    }
    try {
      const times = isAllDay
        ? {
            endDate: Temporal.PlainDate.from(date).add({ days: 1 }).toString(),
            endUtc: plainDateToUtcMs(Temporal.PlainDate.from(date).add({ days: 1 }).toString()),
            startDate: date,
            startUtc: plainDateToUtcMs(date),
          }
        : {
            endUtc: combine(date, endTime, timeZone),
            startTimeZone: timeZone,
            startUtc: combine(date, startTime, timeZone),
          };
      if (!isAllDay && times.endUtc <= times.startUtc) {
        setError('End must be after start.');
        return;
      }
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
            // Empty string clears the field; undefined would read as "unchanged".
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

  const field = 'w-full rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm';

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="w-[420px] rounded-2xl bg-neutral-50 p-6 shadow-2xl"
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{existing ? 'Edit event' : 'New event'}</h2>
          {joinUrl ? (
            <button
              className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-500"
              onClick={() => window.open(joinUrl, '_blank', 'noopener')}
              type="button"
            >
              Join meeting
            </button>
          ) : null}
        </div>

        <div className="flex flex-col gap-3">
          {error ? (
            <p className="select-text rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>
          ) : null}
          {isRecurring ? (
            <div
              aria-label="Apply to"
              className="flex rounded-lg border border-neutral-200 bg-white p-0.5"
              role="radiogroup"
            >
              {SCOPES.map((option) => (
                <button
                  aria-checked={scope === option.value}
                  className={`flex-1 rounded-md px-2 py-1 text-xs font-medium ${
                    scope === option.value
                      ? 'bg-blue-600 text-white'
                      : 'text-neutral-600 hover:bg-neutral-100'
                  }`}
                  key={option.value}
                  onClick={() => setScope(option.value)}
                  role="radio"
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          <input
            autoFocus
            className={field}
            onChange={(changeEvent) => setTitle(changeEvent.target.value)}
            placeholder="Title"
            value={title}
          />
          <select
            className={field}
            disabled={Boolean(existing)}
            onChange={(changeEvent) => setCalendarKey(changeEvent.target.value)}
            value={calendarKey}
          >
            {writable.map((calendar) => (
              <option
                key={`${calendar.accountId}:${calendar.id}`}
                value={`${calendar.accountId}:${calendar.id}`}
              >
                {calendar.summary}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm">
            <input
              checked={isAllDay}
              onChange={(changeEvent) => setIsAllDay(changeEvent.target.checked)}
              type="checkbox"
            />
            All-day
          </label>
          <div className="flex gap-2">
            <input
              className={field}
              onChange={(changeEvent) => setDate(changeEvent.target.value)}
              type="date"
              value={date}
            />
            {isAllDay ? null : (
              <>
                <input
                  className={field}
                  onChange={(changeEvent) => setStartTime(changeEvent.target.value)}
                  type="time"
                  value={startTime}
                />
                <input
                  className={field}
                  onChange={(changeEvent) => setEndTime(changeEvent.target.value)}
                  type="time"
                  value={endTime}
                />
              </>
            )}
          </div>
          <input
            className={field}
            onChange={(changeEvent) => setLocation(changeEvent.target.value)}
            placeholder="Location (optional)"
            value={location}
          />
          {existing ? null : (
            <>
              <div className="flex gap-2">
                <select
                  aria-label="Repeat"
                  className={field}
                  onChange={(changeEvent) =>
                    setRepeat(changeEvent.target.value as RecurrenceFrequency | 'none')
                  }
                  value={repeat}
                >
                  {REPEAT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {repeat === 'none' ? null : (
                  <label className="flex items-center gap-1 text-sm whitespace-nowrap">
                    every
                    <input
                      aria-label="Repeat interval"
                      className={`${field} w-14`}
                      min={1}
                      onChange={(changeEvent) => setRepeatInterval(changeEvent.target.value)}
                      type="number"
                      value={repeatInterval}
                    />
                  </label>
                )}
              </div>
              {repeat === 'none' ? null : (
                <div className="flex gap-2">
                  <select
                    aria-label="Repeat ends"
                    className={field}
                    onChange={(changeEvent) =>
                      setRepeatEnds(changeEvent.target.value as 'after' | 'never' | 'on')
                    }
                    value={repeatEnds}
                  >
                    <option value="never">Never ends</option>
                    <option value="after">Ends after</option>
                    <option value="on">Ends on date</option>
                  </select>
                  {repeatEnds === 'after' ? (
                    <label className="flex items-center gap-1 text-sm whitespace-nowrap">
                      <input
                        aria-label="Occurrence count"
                        className={`${field} w-16`}
                        min={1}
                        onChange={(changeEvent) => setRepeatCount(changeEvent.target.value)}
                        type="number"
                        value={repeatCount}
                      />
                      times
                    </label>
                  ) : null}
                  {repeatEnds === 'on' ? (
                    <input
                      aria-label="Repeat until"
                      className={field}
                      onChange={(changeEvent) => setRepeatUntil(changeEvent.target.value)}
                      type="date"
                      value={repeatUntil}
                    />
                  ) : null}
                </div>
              )}
            </>
          )}
          {existing?.attendees?.length ? (
            <div className="rounded-lg border border-neutral-200 bg-white p-3">
              <p className="mb-1 text-xs font-medium text-neutral-400 uppercase">Invitees</p>
              {ownAttendee ? (
                <div className="mb-2 flex gap-1">
                  {RSVP_OPTIONS.map((option) => (
                    <button
                      className={`flex-1 rounded-md border px-2 py-1 text-xs font-medium ${
                        rsvp === option.value
                          ? 'border-blue-600 bg-blue-600 text-white'
                          : 'border-neutral-200 text-neutral-600 hover:bg-neutral-100'
                      }`}
                      key={option.value}
                      onClick={() => void respond(option.value)}
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : null}
              {existing.attendees.map((attendee) => (
                <p className="select-text text-sm" key={attendee.email}>
                  {attendee.displayName ?? attendee.email}
                  <span className="ml-1 text-xs text-neutral-400">
                    {attendee.responseStatus}
                    {attendee.isOrganizer ? ' · organizer' : ''}
                  </span>
                </p>
              ))}
            </div>
          ) : null}
        </div>

        <div className="mt-5 flex items-center justify-between">
          {existing ? (
            <button
              className="text-sm text-red-600 hover:underline"
              onClick={() => void remove()}
              type="button"
            >
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              className="rounded-lg px-3 py-1.5 text-sm hover:bg-neutral-200"
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            <button
              className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
              onClick={() => void save()}
              type="button"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
