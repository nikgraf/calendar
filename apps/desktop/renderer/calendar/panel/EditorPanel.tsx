import type { CaptureSource } from '@calendar/ai';
import {
  type EditorSeed,
  type EditorSourceKind,
  editorTitle,
  isAtSlot,
  useMoveConfirmation,
  useThreadEditor,
  type TaskEditorSeed,
} from '@calendar/app-state';
import {
  type CalendarInfo,
  formatSlotLabel,
  type ItemKind,
  type TaskListInfo,
  type TaskRecord,
} from '@calendar/core';
import { desktopLanguageModel } from '../../ai/desktopModel.ts';
import { backend } from '../../backend.ts';
import { Button } from '../../ui/Button.tsx';
import { IconButton } from '../../ui/IconButton.tsx';
import { ChevronLeftIcon, ChevronRightIcon, VideoIcon } from '../../ui/icons.tsx';
import { SegmentedControl } from '../../ui/SegmentedControl.tsx';
import { EventEditorForm } from '../EventEditorForm.tsx';
import { InviteeChoices } from '../InviteeChoices.tsx';
import { MoveConfirm } from '../MoveConfirm.tsx';
import { QuickAddBar } from '../QuickAddBar.tsx';
import { ReminderEditorForm } from '../ReminderEditorForm.tsx';
import { TaskEditorForm } from '../TaskEditorForm.tsx';
import { ThreadTurns } from '../ThreadTurns.tsx';
import { FieldFlashContext, useFlash } from '../../ui/useFlash.ts';

const KIND_LABELS: Record<ItemKind, string> = {
  event: 'Event',
  reminder: 'Reminder',
  task: 'Task',
};

const CHANGE_PLACEHOLDER = 'Change it: "at 8", "Thursday instead", "call it…"';

/**
 * The side panel's editor: for a new item the quick-add field on top,
 * then the Event | Task | Reminder control (only the kinds something can
 * hold), then the form. In create mode the control picks the kind; on an
 * existing item it converts (Save writes the other kind and deletes the
 * source) or moves a to-do to the other provider. Both models stay
 * mounted so a flip keeps state. A question before a lossy switch, move,
 * conversion or delete is a footer below the scrolling body, on screen
 * whatever the scroll position (the kind control that asked may be at
 * the top, Save at the bottom).
 *
 * A new item is a thread (`useThreadEditor`, shared with the iOS edit
 * sheet): the first phrase makes the draft(s), every later phrase in the
 * same field changes them, Undo takes a turn back, and the calendar
 * draws every draft hatched, the focused one outlined and scrolled to
 * (the draft atoms). A phrase that asks for free time puts the draft in
 * the best free slot and offers the others as a chip row here and as
 * fainter candidate blocks on the grid; a chip or a candidate moves the
 * draft there. People the words invite join the form's invitees when a
 * contact is theirs alone, else they wait here for a contact to be
 * picked. The form is the focused draft's view: its edits go back
 * into the thread, and a focus change (the pager, or a click on a block)
 * swaps the form. Save writes the focused draft; with several, "Add all"
 * writes the rest as they are and the focused one through the form. The
 * e2e suite relies on the title text ("New event", "Edit reminder", …),
 * the mode test ids and the `draft-*` test ids.
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
  /** Save went through, as an event or a task. */
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
  const {
    addAll,
    applying,
    batchError,
    canAddAll,
    dismissInvitee,
    drafts,
    eventModel,
    flash,
    focused,
    focusedDraft,
    inviteeChoices,
    kinds,
    liveItem,
    moveToSlot,
    onPhrase,
    pickInvitee,
    settled,
    switchFocus,
    taskModel,
    thread,
    turns,
    userEdits,
    write,
  } = useThreadEditor({
    backend,
    calendars,
    confirm: moveConfirmation.request,
    initialKind,
    model: desktopLanguageModel,
    onClose,
    onSaved,
    seed,
    sourceKind,
    task,
    taskLists,
    taskSeed,
    timeZone,
  });
  const { joinUrl } = eventModel;
  const { apply, available, kind, mode, seriesOnly, switchTo } = kinds;
  // A turn that made the item the other kind: the control tints and fades back.
  const kindFlash = useFlash<HTMLDivElement>(flash?.fields.has('kind') ? flash.key : null);

  const showToggle =
    available.length > 1 &&
    !(sourceKind === 'event' && eventModel.readOnly) &&
    !(sourceKind === 'task' && taskModel.readOnly);
  const { noun, verb } = editorTitle({ kind, sourceKind, sourceProvider: task?.provider });
  const title = `${verb} ${noun}`;
  // What the thread shows under the field's card: a caveat, the free slots,
  // the names to pick a contact for, the pager.
  const threadNote = seed.thread?.note && drafts.length > 0 ? seed.thread.note : undefined;
  const threadSlots =
    focusedDraft?.slots && focusedDraft.slots.length > 1 && liveItem.kind === 'event'
      ? focusedDraft.slots
      : undefined;

  return (
    <div
      aria-label={mode === 'todo' ? 'Task editor' : 'Event editor'}
      className="flex min-h-0 flex-1 flex-col"
      data-testid="editor"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-3 pb-4">
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
            editKey={userEdits}
            fallbackDate={seed.initialDate.toString()}
            focusSignal={quickAddFocus}
            hold={applying}
            onApply={(item) => void apply(item)}
            onCapture={onCapture}
            onPhrase={onPhrase}
            placeholder={drafts.length > 0 ? CHANGE_PLACEHOLDER : undefined}
            timeZone={timeZone}
          >
            {/* The turns hang under the field, as part of it. */}
            {turns.length > 0 ? (
              <ThreadTurns
                onUndo={thread.undo}
                turns={turns}
                undoDisabled={thread.busy || !settled}
              />
            ) : null}
          </QuickAddBar>
        ) : null}

        {threadNote ||
        threadSlots ||
        inviteeChoices.length > 0 ||
        drafts.length > 1 ||
        batchError ? (
          <div className="mb-3 flex flex-col gap-2" data-testid="draft-thread">
            {threadNote ? (
              <p className="text-xs text-ink-secondary" data-testid="draft-thread-note">
                {threadNote}
              </p>
            ) : null}
            {threadSlots ? (
              // The free slots a finder phrase found: the draft sits in the
              // pressed one; another moves it there, like its block on the grid.
              <div className="flex flex-col gap-1" data-testid="draft-slots">
                <span className="text-xs text-ink-secondary">Free slots</span>
                <div className="flex flex-wrap gap-1.5">
                  {threadSlots.map((slot, index) => {
                    const chosen = isAtSlot(liveItem, slot);
                    return (
                      <Button
                        aria-pressed={chosen}
                        className={chosen ? 'ring-2 ring-focus' : ''}
                        data-testid={`draft-slot-${String(index)}`}
                        disabled={!settled}
                        key={`${slot.date}T${slot.startTime}`}
                        onClick={() => moveToSlot(slot)}
                        size="sm"
                      >
                        {formatSlotLabel(slot)}
                      </Button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {inviteeChoices.length > 0 ? (
              <InviteeChoices
                choices={inviteeChoices}
                disabled={!settled}
                onDismiss={dismissInvitee}
                onPick={pickInvitee}
              />
            ) : null}
            {drafts.length > 1 ? (
              <div className="flex items-center justify-between" data-testid="draft-pager">
                <div className="flex items-center gap-1">
                  <IconButton
                    data-testid="draft-prev"
                    disabled={focused === 0 || !settled}
                    label="Previous draft"
                    onClick={() => switchFocus(focused - 1)}
                    size="sm"
                  >
                    <ChevronLeftIcon size={14} />
                  </IconButton>
                  <span className="text-xs text-ink-secondary" data-testid="draft-position">
                    {focused + 1} of {drafts.length}
                  </span>
                  <IconButton
                    data-testid="draft-next"
                    disabled={focused >= drafts.length - 1 || !settled}
                    label="Next draft"
                    onClick={() => switchFocus(focused + 1)}
                    size="sm"
                  >
                    <ChevronRightIcon size={14} />
                  </IconButton>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    data-testid="draft-remove"
                    disabled={!settled}
                    onClick={() => thread.remove(focused)}
                    size="sm"
                    variant="ghost"
                  >
                    Remove
                  </Button>
                  {canAddAll ? (
                    <Button
                      aria-busy={write.busy}
                      data-testid="draft-add-all"
                      disabled={moveConfirmation.pending !== null || !settled}
                      onClick={() => void addAll()}
                      size="sm"
                      variant="primary"
                    >
                      Add all {drafts.length}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {batchError ? (
              <p
                className="select-text rounded-control bg-fill p-2 text-sm text-danger"
                data-testid="draft-batch-error"
              >
                {batchError}
              </p>
            ) : null}
          </div>
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
            ref={kindFlash}
            size="sm"
            value={kind}
          />
        ) : null}

        {/* The fields the last turn changed flash (`useFieldFlash`). */}
        <FieldFlashContext value={flash}>
          {mode === 'todo' ? (
            // The selected list's provider picks the form: a Reminders list
            // exposes time/priority/alert/repeat/URL; a Google list gets the
            // plain title/date/notes form. The kind control moves between the
            // providers; the list picker stays within one.
            taskModel.provider === 'apple' ? (
              <ReminderEditorForm
                moveConfirmation={moveConfirmation}
                onClose={onClose}
                saveDisabled={write.busy}
                task={task}
                taskModel={taskModel}
              />
            ) : (
              <TaskEditorForm
                moveConfirmation={moveConfirmation}
                onClose={onClose}
                saveDisabled={write.busy}
                task={task}
                taskModel={taskModel}
              />
            )
          ) : (
            <EventEditorForm
              model={eventModel}
              moveConfirmation={moveConfirmation}
              onClose={onClose}
              saveDisabled={write.busy}
            />
          )}
        </FieldFlashContext>
      </div>
      {moveConfirmation.pending ? (
        <div className="shrink-0 px-4 pt-2 pb-4">
          <MoveConfirm moveConfirmation={moveConfirmation} />
        </div>
      ) : null}
    </div>
  );
}
