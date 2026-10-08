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
import { type CalendarInfo, type TaskListInfo, type TaskRecord } from '@calendar/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../ui/Button.tsx';
import { VideoIcon } from '../../ui/icons.tsx';
import { SegmentedControl } from '../../ui/SegmentedControl.tsx';
import { EventEditorForm } from '../EventEditorForm.tsx';
import { ReminderEditorForm } from '../ReminderEditorForm.tsx';
import { TaskEditorForm } from '../TaskEditorForm.tsx';

/** Existing event (edit mode) or a prefilled slot (create mode). */
export type EditorSeed = EventEditorSeed;

/**
 * The side panel's editor: the event and task forms behind one Event |
 * Task toggle. In create mode the toggle picks the kind; on an existing
 * item it converts (Save writes the other kind and deletes the source).
 * Both models stay mounted so a flip keeps state. The e2e suite relies
 * on the title text ("New event", "Edit reminder", …) and the mode
 * test ids.
 */
export function EditorPanel({
  calendars,
  initialMode,
  onClose,
  onSaved,
  seed,
  task,
  taskLists,
  taskPrefill,
  timeZone,
}: {
  calendars: ReadonlyArray<CalendarInfo>;
  /** Open on the task form: a quick-add phrase understood as a task, or Convert from the inspector. */
  initialMode?: 'event' | 'task' | undefined;
  onClose: () => void;
  /** Save went through, as an event or a task (capture marks its row added). */
  onSaved?: (() => void) | undefined;
  seed: EditorSeed;
  /** Present when the editor was opened from a task chip (task edit mode). */
  task?: TaskRecord | undefined;
  taskLists: ReadonlyArray<TaskListInfo>;
  /** A new task to open with (a quick-add phrase understood as a task). */
  taskPrefill?: Pick<TaskEditorSeed, 'dated' | 'initialTime' | 'title'> | undefined;
  timeZone: string;
}) {
  const sourceKind: EditorSourceKind = task ? 'task' : seed.event ? 'event' : 'new';
  // An existing event asked to open as a task (the inspector's Convert)
  // still starts as the event and switches below: the switch is what
  // carries the title, notes, rule and URL over and asks about a loss.
  const convertOnOpen = initialMode === 'task' && sourceKind === 'event';
  const [mode, setMode] = useState<'event' | 'task'>(
    convertOnOpen ? 'event' : (initialMode ?? (task || taskPrefill ? 'task' : 'event')),
  );
  const moveConfirmation = useMoveConfirmation();
  const mutations = useBackendMutations();
  const taskModel = useTaskEditorModel({
    confirm: moveConfirmation.request,
    onClose,
    onSaved,
    seed: {
      convertFromEvent: seed.event,
      dated: taskPrefill?.dated,
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

  const switchTo = useCallback(
    async (next: 'event' | 'task') => {
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
    },
    [
      eventModel,
      mode,
      moveConfirmation.request,
      mutations.previewEventToTask,
      sourceKind,
      taskModel,
      timeZone,
    ],
  );
  const showToggle =
    !(sourceKind === 'event' && eventModel.readOnly) &&
    !(sourceKind === 'task' && taskModel.readOnly);
  // A series converts as a whole, like it moves: an occurrence-scoped edit stays an event.
  const seriesOnly =
    sourceKind === 'event' && eventModel.isRecurring && eventModel.scope !== 'series';
  // A series converts as a whole: the inspector seeds `initialScope:
  // 'series'`, so the switch never runs on an occurrence (`seriesOnly`).
  const converted = useRef(false);
  useEffect(() => {
    if (convertOnOpen && !converted.current && !seriesOnly) {
      converted.current = true;
      void switchTo('task');
    }
  }, [convertOnOpen, seriesOnly, switchTo]);
  const taskWord = taskModel.provider === 'apple' ? 'reminder' : 'task';
  const title =
    mode === 'task'
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
    <div
      aria-label={mode === 'task' ? 'Task editor' : 'Event editor'}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-3 pb-4"
      data-testid="editor"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold" data-testid="editor-title">
          {title}
        </h2>
        {joinUrl ? (
          <Button onClick={() => window.open(joinUrl, '_blank', 'noopener')} size="sm">
            <VideoIcon size={14} />
            Join meeting
          </Button>
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
          value={mode}
        />
      ) : null}

      {mode === 'task' ? (
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
        <EventEditorForm model={eventModel} moveConfirmation={moveConfirmation} onClose={onClose} />
      )}
    </div>
  );
}
