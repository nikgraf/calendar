import type { CaptureSource } from '@calendar/ai';
import {
  type EditorSourceKind,
  editorTitle,
  useBackendMutations,
  useEditorKinds,
  useEventEditorModel,
  useMoveConfirmation,
  useTaskEditorModel,
  type EventEditorSeed,
  type TaskEditorSeed,
} from '@calendar/app-state';
import {
  type CalendarInfo,
  type ItemKind,
  type TaskListInfo,
  type TaskRecord,
} from '@calendar/core';
import { Button } from '../../ui/Button.tsx';
import { VideoIcon } from '../../ui/icons.tsx';
import { SegmentedControl } from '../../ui/SegmentedControl.tsx';
import { EventEditorForm } from '../EventEditorForm.tsx';
import { QuickAddBar } from '../QuickAddBar.tsx';
import { ReminderEditorForm } from '../ReminderEditorForm.tsx';
import { TaskEditorForm } from '../TaskEditorForm.tsx';

/** Existing event (edit mode) or a prefilled slot (create mode). */
export type EditorSeed = EventEditorSeed;

const KIND_LABELS: Record<ItemKind, string> = {
  event: 'Event',
  reminder: 'Reminder',
  task: 'Task',
};

/**
 * The side panel's editor: for a new item the quick-add field on top,
 * then the Event | Task | Reminder control (only the kinds something can
 * hold), then the form. In create mode the control picks the kind; on an
 * existing item it converts (Save writes the other kind and deletes the
 * source) or moves a to-do to the other provider. Both models stay
 * mounted so a flip keeps state. The e2e suite relies on the title text
 * ("New event", "Edit reminder", …) and the mode test ids.
 */
export function EditorPanel({
  calendars,
  initialKind,
  onCapture,
  onClose,
  onSaved,
  quickAddFocus = 0,
  seed,
  task,
  taskLists,
  taskSeed,
  timeZone,
}: {
  calendars: ReadonlyArray<CalendarInfo>;
  /** The kind to open on: a to-do for a "+" that wants one, or Convert from the inspector. */
  initialKind?: ItemKind | undefined;
  /** A paste into the quick-add field that is an email or an image goes to capture. */
  onCapture: (source: CaptureSource) => void;
  onClose: () => void;
  /** Save went through, as an event or a task (capture marks its row added). */
  onSaved?: (() => void) | undefined;
  /** ⌘K: bumped to focus the quick-add field of an open new-item editor. */
  quickAddFocus?: number | undefined;
  seed: EditorSeed;
  /** Present when the editor was opened from a task chip (task edit mode). */
  task?: TaskRecord | undefined;
  taskLists: ReadonlyArray<TaskListInfo>;
  /** A new to-do's start: undated (an inbox add) and the list to open in. */
  taskSeed?: Pick<TaskEditorSeed, 'dated' | 'listKey'> | undefined;
  timeZone: string;
}) {
  const sourceKind: EditorSourceKind = task ? 'task' : seed.event ? 'event' : 'new';
  const moveConfirmation = useMoveConfirmation();
  const mutations = useBackendMutations();
  const taskModel = useTaskEditorModel({
    confirm: moveConfirmation.request,
    onClose,
    onSaved,
    seed: {
      convertFromEvent: seed.event,
      dated: taskSeed?.dated,
      existing: task,
      initialDate: seed.initialDate.toString(),
      initialTime: seed.initialTimes?.startTime,
      kind: initialKind === 'event' ? undefined : initialKind,
      listKey: taskSeed?.listKey,
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
  const { joinUrl } = eventModel;
  const kinds = useEditorKinds({
    calendars,
    confirm: moveConfirmation.request,
    eventModel,
    initialKind,
    previewEventToTask: mutations.previewEventToTask,
    sourceKind,
    taskLists,
    taskModel,
    timeZone,
  });
  const { apply, available, kind, mode, seriesOnly, switchTo } = kinds;

  const showToggle =
    available.length > 1 &&
    !(sourceKind === 'event' && eventModel.readOnly) &&
    !(sourceKind === 'task' && taskModel.readOnly);
  const { noun, verb } = editorTitle({ kind, sourceKind, sourceProvider: task?.provider });
  const title = `${verb} ${noun}`;

  return (
    <div
      aria-label={mode === 'todo' ? 'Task editor' : 'Event editor'}
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

      {sourceKind === 'new' ? (
        <QuickAddBar
          fallbackDate={seed.initialDate.toString()}
          focusSignal={quickAddFocus}
          onApply={(item) => void apply(item)}
          onCapture={onCapture}
          timeZone={timeZone}
        />
      ) : null}

      {showToggle ? (
        <SegmentedControl
          className="mb-3 w-full"
          grow
          label="Kind"
          onChange={(option) => void switchTo(option)}
          options={available.map((option) => ({
            disabled: moveConfirmation.pending !== null || (option !== 'event' && seriesOnly),
            label: KIND_LABELS[option],
            testId: `mode-${option}`,
            title:
              option !== 'event' && seriesOnly
                ? 'Choose "All events" to convert a series'
                : undefined,
            value: option,
          }))}
          size="sm"
          value={kind}
        />
      ) : null}

      {mode === 'todo' ? (
        // The selected list's provider picks the form: a Reminders list
        // exposes time/priority/alert/repeat/URL; a Google list gets the
        // plain title/date/notes form. The kind control moves between the
        // providers; the list picker stays within one.
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
