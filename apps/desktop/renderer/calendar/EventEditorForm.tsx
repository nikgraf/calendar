import {
  REPEAT_ENDS_OPTIONS,
  REPEAT_OPTIONS,
  RSVP_OPTIONS,
  SCOPE_OPTIONS,
  type useEventEditorModel,
} from '@calendar/app-state';
import type { RecurrenceFrequency } from '@calendar/core';
import { InviteeCombobox } from './InviteeCombobox.tsx';

const field = 'w-full rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm';

/**
 * The event half of EventEditor (mode === 'event'), extracted like the iOS
 * EventEditForm. The e2e suite relies on the Title placeholder, the
 * Repeat/Apply-to labels and the Delete/Cancel/Save buttons.
 */
export function EventEditorForm({
  model,
  onClose,
}: {
  model: ReturnType<typeof useEventEditorModel>;
  onClose: () => void;
}) {
  const {
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
    location,
    ownAttendee,
    remove,
    removeAttendee,
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
    writableCalendars: writable,
  } = model;

  return (
    <>
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
            {SCOPE_OPTIONS.map((option) => (
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
                  {REPEAT_ENDS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
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
          <InviteeCombobox
            attendees={attendees}
            attendeeStatus={attendeeStatus}
            onAdd={addAttendee}
            onRemove={removeAttendee}
          />
        </div>
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
    </>
  );
}
