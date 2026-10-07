import { SegmentedControl } from '../ui/SegmentedControl.tsx';
import {
  type EditorSourceKind,
  switchEditorMode,
  useBackendMutations,
  useEventEditorModel,
  useMoveConfirmation,
  useTaskEditorModel,
  type EventEditorSeed,
  type TaskEditorSeed,
} from '@calendar/app-state';
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
  onSaved,
  seed,
  task,
  taskLists,
  taskPrefill,
  timeZone,
}: {
  /** Present when opened from a birthday chip: a read-only detail, nothing to edit. */
  birthday?: BirthdayOccurrence | undefined;
  calendars: ReadonlyArray<CalendarInfo>;
  onClose: () => void;
  /** Save went through, as an event or a task (capture marks its row added). */
  onSaved?: (() => void) | undefined;
  seed: EditorSeed;
  /** Present when the editor was opened from a task chip (task edit mode). */
  task?: TaskRecord | undefined;
  taskLists: ReadonlyArray<TaskListInfo>;
  /** A new task to open with (a quick-add phrase understood as a task): the editor starts in task mode. */
  taskPrefill?: Pick<TaskEditorSeed, 'initialTime' | 'title'> | undefined;
  timeZone: string;
}) {
  const sourceKind: EditorSourceKind = birthday
    ? 'birthday'
    : task
      ? 'task'
      : seed.event
        ? 'event'
        : 'new';
  // The Event | Task toggle: in create mode it picks the kind, on an
  // existing item it converts (Save then writes the other kind and
  // deletes the source). Both models stay mounted so a flip keeps state.
  const [mode, setMode] = useState<'birthday' | 'event' | 'task'>(
    birthday ? 'birthday' : task || taskPrefill ? 'task' : 'event',
  );
  const moveConfirmation = useMoveConfirmation();
  const mutations = useBackendMutations();
  const taskModel = useTaskEditorModel({
    confirm: moveConfirmation.request,
    onClose,
    onSaved,
    seed: {
      convertFromEvent: seed.event,
      existing: task,
      initialDate: seed.initialDate.toString(),
      initialTime: taskPrefill?.initialTime ?? seed.initialTimes?.startTime,
      title: taskPrefill?.title,
    },
    taskLists,
  });
  const eventModel = useEventEditorModel({
    calendars,
    confirm: moveConfirmation.request,
    onClose,
    onSaved,
    seed: { ...seed, convertFromTask: task },
    timeZone,
  });
  const { existing, joinUrl } = eventModel;

  const switchTo = async (next: 'event' | 'task') => {
    if (next === mode) {
      return;
    }
    const switched = await switchEditorMode({
      confirm: moveConfirmation.request,
      eventModel,
      next,
      previewEventToTask: mutations.previewEventToTask,
      sourceKind,
      taskModel,
      timeZone,
    });
    if (switched) {
      setMode(next);
    }
  };
  const showToggle =
    mode !== 'birthday' &&
    !(sourceKind === 'event' && eventModel.readOnly) &&
    !(sourceKind === 'task' && taskModel.readOnly);
  // A series converts as a whole, like it moves: an occurrence-scoped edit stays an event.
  const seriesOnly =
    sourceKind === 'event' && eventModel.isRecurring && eventModel.scope !== 'series';
  const taskWord = taskModel.provider === 'apple' ? 'reminder' : 'task';
  const title =
    mode === 'birthday'
      ? 'Birthday'
      : mode === 'task'
        ? sourceKind === 'event'
          ? `Convert to ${taskWord}`
          : task
            ? `Edit ${taskWord}`
            : 'New task'
        : sourceKind === 'task'
          ? 'Convert to event'
          : existing
            ? 'Edit event'
            : 'New event';

  return (
    <Dialog
      label={mode === 'birthday' ? 'Birthday' : mode === 'task' ? 'Task editor' : 'Event editor'}
      onClose={onClose}
      panelClassName="w-[420px] rounded-2xl bg-surface-subtle p-6 shadow-2xl"
      zIndex={30}
    >
      <>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
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

        {showToggle ? (
          <SegmentedControl
            className="mb-3 w-full"
            grow
            label="Kind"
            onChange={(option) => void switchTo(option)}
            options={[
              {
                disabled: moveConfirmation.pending !== null,
                label: 'Event',
                testId: 'mode-event',
                value: 'event',
              },
              {
                disabled: moveConfirmation.pending !== null || seriesOnly,
                label: 'Task',
                testId: 'mode-task',
                title: seriesOnly ? 'Choose "All events" to convert a series' : undefined,
                value: 'task',
              },
            ]}
            size="sm"
            value={mode === 'task' ? 'task' : 'event'}
          />
        ) : null}

        {mode === 'birthday' && birthday ? (
          <BirthdayDetail occurrence={birthday} onClose={onClose} timeZone={timeZone} />
        ) : mode === 'task' ? (
          // The selected list's provider picks the form: a Reminders list
          // exposes time/priority/alert/repeat/URL; a Google list gets the
          // plain title/date/notes form. Either list can be in another
          // account or provider — Save then moves the task.
          taskModel.provider === 'apple' ? (
            <ReminderEditorForm
              moveConfirmation={moveConfirmation}
              onClose={onClose}
              task={task}
              taskModel={taskModel}
            />
          ) : (
            <TaskEditorForm
              moveConfirmation={moveConfirmation}
              onClose={onClose}
              task={task}
              taskModel={taskModel}
            />
          )
        ) : (
          <EventEditorForm
            model={eventModel}
            moveConfirmation={moveConfirmation}
            onClose={onClose}
          />
        )}
      </>
    </Dialog>
  );
}
