import { useBackend } from '@calendar/app-state';
import {
  plainDateToUtcMs,
  Temporal,
  toZonedDateTime,
  type CalendarInfo,
  type EventDraft,
  type EventRecord,
} from '@calendar/core';
import { Effect } from 'effect';
import { useState } from 'react';

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
  const { client } = useBackend();
  const existing = seed.event;
  const isRecurring = Boolean(existing && (existing.recurrence || existing.recurringEventId));
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
      if (existing) {
        await Effect.runPromise(
          client.updateEvent({
            accountId,
            calendarId,
            changes: {
              isAllDay,
              location: location || undefined,
              title: title.trim(),
              ...times,
            },
            eventId: existing.id,
          }),
        );
      } else {
        const draft: EventDraft = {
          accountId,
          calendarId,
          isAllDay,
          location: location || undefined,
          title: title.trim(),
          ...times,
        };
        await Effect.runPromise(client.createEvent(draft));
      }
      onClose();
    } catch (error) {
      setError(String(error));
    }
  };

  const remove = async () => {
    if (!existing) {
      return;
    }
    try {
      await Effect.runPromise(
        client.deleteEvent({
          accountId: existing.accountId,
          calendarId: existing.calendarId,
          eventId: existing.id,
        }),
      );
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
        <h2 className="mb-4 text-lg font-semibold">{existing ? 'Edit event' : 'New event'}</h2>

        {isRecurring ? (
          <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            Editing recurring events isn’t supported yet.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {error ? (
              <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>
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
            {existing?.attendees?.length ? (
              <div className="rounded-lg border border-neutral-200 bg-white p-3">
                <p className="mb-1 text-xs font-medium text-neutral-400 uppercase">Invitees</p>
                {existing.attendees.map((attendee) => (
                  <p className="text-sm" key={attendee.email}>
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
        )}

        <div className="mt-5 flex items-center justify-between">
          {existing && !isRecurring ? (
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
            {isRecurring ? null : (
              <button
                className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
                onClick={() => void save()}
                type="button"
              >
                Save
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
