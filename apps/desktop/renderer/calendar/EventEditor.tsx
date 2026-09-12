import { useEventEditorModel, useTaskEditorModel, type EventEditorSeed } from '@calendar/app-state';
import { useState } from 'react';
import { Dialog } from '../Dialog.tsx';
import { BirthdayDetail } from './BirthdayDetail.tsx';
import { EventEditorForm } from './EventEditorForm.tsx';
import { ReminderEditorForm } from './ReminderEditorForm.tsx';
import { TaskEditorForm } from './TaskEditorForm.tsx';
import {
  type BirthdayOccurrence,
  type CalendarInfo,
  type TaskListInfo,
  type TaskRecord,
} from '@calendar/core';

/** Existing event (edit mode) or a prefilled slot (create mode). */
export type EditorSeed = EventEditorSeed;

export function EventEditor({
  birthday,
  calendars,
  onClose,
  seed,
  task,
  taskLists,
  timeZone,
}: {
  /** Present when opened from a birthday chip: a read-only detail, nothing to edit. */
  birthday?: BirthdayOccurrence | undefined;
  calendars: ReadonlyArray<CalendarInfo>;
  onClose: () => void;
  seed: EditorSeed;
  /** Present when the editor was opened from a task chip (task edit mode). */
  task?: TaskRecord | undefined;
  taskLists: ReadonlyArray<TaskListInfo>;
  timeZone: string;
}) {
  // Create mode offers an Event | Task toggle; a chip click fixes the mode.
  const [mode, setMode] = useState<'birthday' | 'event' | 'task'>(
    birthday ? 'birthday' : task ? 'task' : 'event',
  );
  const taskModel = useTaskEditorModel({
    onClose,
    seed: { existing: task, initialDate: seed.initialDate.toString() },
    taskLists,
  });
  const eventModel = useEventEditorModel({ calendars, onClose, seed, timeZone });
  const { existing, joinUrl } = eventModel;

  return (
    <Dialog
      label={mode === 'birthday' ? 'Birthday' : mode === 'task' ? 'Task editor' : 'Event editor'}
      onClose={onClose}
      panelClassName="w-[420px] rounded-2xl bg-neutral-50 p-6 shadow-2xl"
      zIndex={30}
    >
      <>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {mode === 'birthday'
              ? 'Birthday'
              : mode === 'task'
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

        {!existing && !task && !birthday ? (
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

        {mode === 'birthday' && birthday ? (
          <BirthdayDetail occurrence={birthday} onClose={onClose} timeZone={timeZone} />
        ) : mode === 'task' ? (
          // The selected list's provider picks the form: a Reminders list
          // exposes time/priority/alert/repeat/URL and can move; a Google
          // list gets the plain title/date/notes form.
          taskModel.provider === 'apple' ? (
            <ReminderEditorForm onClose={onClose} task={task} taskModel={taskModel} />
          ) : (
            <TaskEditorForm onClose={onClose} task={task} taskModel={taskModel} />
          )
        ) : (
          <EventEditorForm model={eventModel} onClose={onClose} />
        )}
      </>
    </Dialog>
  );
}
