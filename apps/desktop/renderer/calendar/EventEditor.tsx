import { useEventEditorModel, useTaskEditorModel, type EventEditorSeed } from '@calendar/app-state';
import { useState } from 'react';
import { InviteeCombobox } from './InviteeCombobox.tsx';
import { ReminderEditorForm } from './ReminderEditorForm.tsx';
import { TaskEditorForm } from './TaskEditorForm.tsx';
import { REPEAT_OPTIONS } from './taskEditorOptions.ts';
import {
  type CalendarInfo,
  type RecurrenceFrequency,
  type RecurringScope,
  type RsvpResponse,
  type TaskListInfo,
  type TaskRecord,
} from '@calendar/core';

const RSVP_OPTIONS: ReadonlyArray<{ label: string; value: RsvpResponse }> = [
  { label: 'Accept', value: 'accepted' },
  { label: 'Maybe', value: 'tentative' },
  { label: 'Decline', value: 'declined' },
];

const SCOPES: ReadonlyArray<{ label: string; value: RecurringScope }> = [
  { label: 'This event', value: 'instance' },
  { label: 'This and following', value: 'following' },
  { label: 'All events', value: 'series' },
];

/** Existing event (edit mode) or a prefilled slot (create mode). */
export type EditorSeed = EventEditorSeed;

export function EventEditor({
  calendars,
  onClose,
  seed,
  task,
  taskLists,
  timeZone,
}: {
  calendars: ReadonlyArray<CalendarInfo>;
  onClose: () => void;
  seed: EditorSeed;
  /** Present when the editor was opened from a task chip (task edit mode). */
  task?: TaskRecord | undefined;
  taskLists: ReadonlyArray<TaskListInfo>;
  timeZone: string;
}) {
  // Create mode offers an Event | Task toggle; a chip click fixes the mode.
  const [mode, setMode] = useState<'event' | 'task'>(task ? 'task' : 'event');
  const taskModel = useTaskEditorModel({
    onClose,
    seed: { existing: task, initialDate: seed.initialDate.toString() },
    taskLists,
  });
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
    joinUrl,
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
  } = useEventEditorModel({ calendars, onClose, seed, timeZone });

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
          <h2 className="text-lg font-semibold">
            {mode === 'task'
              ? task
                ? taskModel.provider === 'apple'
                  ? 'Edit reminder'
                  : 'Edit task'
                : 'New task'
              : existing
                ? 'Edit event'
                : 'New event'}
          </h2>
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

        {!existing && !task ? (
          <div className="mb-3 flex rounded-lg border border-neutral-200 bg-white p-0.5">
            {(['event', 'task'] as const).map((option) => (
              <button
                className={`flex-1 rounded-md px-2 py-1 text-xs font-medium ${
                  mode === option ? 'bg-blue-600 text-white' : 'text-neutral-600'
                }`}
                key={option}
                onClick={() => setMode(option)}
                type="button"
              >
                {option === 'event' ? 'Event' : 'Task'}
              </button>
            ))}
          </div>
        ) : null}

        {mode === 'task' ? (
          // The selected list's provider picks the form: a Reminders list
          // exposes time/priority/alert/repeat/URL and can move; a Google
          // list gets the plain title/date/notes form.
          taskModel.provider === 'apple' ? (
            <ReminderEditorForm onClose={onClose} task={task} taskModel={taskModel} />
          ) : (
            <TaskEditorForm onClose={onClose} task={task} taskModel={taskModel} />
          )
        ) : (
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
        )}
      </div>
    </div>
  );
}
