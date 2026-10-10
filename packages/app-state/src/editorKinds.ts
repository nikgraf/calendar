import {
  availableItemKinds,
  type CalendarInfo,
  defaultTodoList,
  type EventToTaskPreview,
  ITEM_KINDS,
  type ItemKind,
  type PreviewEventToTaskParams,
  type TaskListInfo,
  type TaskProvider,
  todoKindOf,
  type TodoKind,
} from '@calendar/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorConfirmRequest, useEventEditorModel } from './editorModel.ts';
import { type EditorMode, type EditorSourceKind, switchEditorMode } from './editorSwitch.ts';
import { convertQuickAddItem, type QuickAddItem } from './quickAddItem.ts';
import { getLastUsedTaskListKey, type useTaskEditorModel } from './taskEditorModel.ts';

/**
 * The to-do kind a phrase understood as a to-do lands on when the editor
 * is on the event form: the kind of the list a new to-do would open in.
 */
export const defaultTodoKind = (taskLists: ReadonlyArray<TaskListInfo>): TodoKind =>
  todoKindOf(
    defaultTodoList(taskLists, { lastUsedKey: getLastUsedTaskListKey() })?.provider ?? 'google',
  );

/** The editor's heading, as words: the shell capitalizes the noun its own way. */
export const editorTitle = ({
  kind,
  sourceKind,
  sourceProvider,
}: {
  readonly kind: ItemKind;
  readonly sourceKind: EditorSourceKind;
  /** An existing to-do's provider: its own kind. */
  readonly sourceProvider?: TaskProvider | undefined;
}): { readonly noun: ItemKind; readonly verb: 'Convert to' | 'Edit' | 'Move to' | 'New' } => {
  if (sourceKind === 'new' || sourceKind === 'birthday') {
    return { noun: kind, verb: 'New' };
  }
  if (sourceKind === 'event') {
    return kind === 'event' ? { noun: 'event', verb: 'Edit' } : { noun: kind, verb: 'Convert to' };
  }
  const own = todoKindOf(sourceProvider ?? 'google');
  if (kind === 'event') {
    return { noun: 'event', verb: 'Convert to' };
  }
  return kind === own ? { noun: own, verb: 'Edit' } : { noun: kind, verb: 'Move to' };
};

/**
 * The Event | Task | Reminder control behind both shells' editors: which
 * kinds are on offer, which one the form shows, the switch between them
 * (`switchEditorMode`), and the quick-add field's apply. The event model
 * and the task model stay mounted side by side; `kind` reads the task
 * model's provider, so a Reminders list means Reminder.
 */
export const useEditorKinds = ({
  calendars,
  confirm,
  eventModel,
  initialKind,
  previewEventToTask,
  sourceKind,
  taskLists,
  taskModel,
  timeZone,
}: {
  readonly calendars: ReadonlyArray<CalendarInfo>;
  readonly confirm: (request: EditorConfirmRequest) => Promise<boolean>;
  readonly eventModel: ReturnType<typeof useEventEditorModel>;
  /**
   * The kind to open on. For a new item the task model's seed decides the
   * list (and so task vs. reminder); for an existing event a to-do kind
   * means Convert: the editor starts as the event and switches at once,
   * which carries the fields over and asks about a loss.
   */
  readonly initialKind?: ItemKind | undefined;
  readonly previewEventToTask: (params: PreviewEventToTaskParams) => Promise<EventToTaskPreview>;
  readonly sourceKind: EditorSourceKind;
  readonly taskLists: ReadonlyArray<TaskListInfo>;
  readonly taskModel: ReturnType<typeof useTaskEditorModel>;
  readonly timeZone: string;
}) => {
  const convertOnOpen =
    initialKind !== undefined && initialKind !== 'event' && sourceKind === 'event';
  const [mode, setMode] = useState<EditorMode>(() =>
    sourceKind === 'task' ||
    (sourceKind === 'new' && initialKind !== undefined && initialKind !== 'event')
      ? 'todo'
      : 'event',
  );
  const kind: ItemKind = mode === 'event' ? 'event' : todoKindOf(taskModel.provider);
  // What a new item can be — and what this item is, whatever its list
  // or calendar can take now.
  const offered = availableItemKinds({ calendars, taskLists });
  const available = ITEM_KINDS.filter((option) => option === kind || offered.includes(option));

  const switchTo = useCallback(
    async (next: ItemKind): Promise<boolean> => {
      if (next === kind) {
        return true;
      }
      const switched = await switchEditorMode({
        confirm,
        eventModel,
        from: mode,
        next,
        previewEventToTask,
        sourceKind,
        taskModel,
        timeZone,
      });
      if (switched) {
        setMode(next === 'event' ? 'event' : 'todo');
      }
      return switched;
    },
    [confirm, eventModel, kind, mode, previewEventToTask, sourceKind, taskModel, timeZone],
  );

  // A series converts as a whole, like it moves: an occurrence-scoped
  // edit stays an event (the detail views seed `initialScope: 'series'`,
  // so the switch never runs on an occurrence).
  const seriesOnly =
    sourceKind === 'event' && eventModel.isRecurring && eventModel.scope !== 'series';
  const converted = useRef(false);
  useEffect(() => {
    if (convertOnOpen && !converted.current && !seriesOnly && initialKind !== undefined) {
      converted.current = true;
      void switchTo(initialKind);
    }
  }, [convertOnOpen, initialKind, seriesOnly, switchTo]);

  /**
   * A parsed phrase (or a picked slot) fills the form. A phrase read as
   * the other kind switches the editor first — a to-do lands on the kind
   * a new to-do would open in — with the switch's own question about a
   * loss; declined, or with that kind unavailable, the phrase is read as
   * the kind the editor shows.
   */
  const apply = async (item: QuickAddItem) => {
    const wanted: ItemKind =
      item.kind === 'event'
        ? 'event'
        : mode === 'todo'
          ? kind
          : defaultTodoKind(taskModel.offeredLists);
    let target = available.includes(wanted) ? wanted : kind;
    if (target !== kind && !(await switchTo(target))) {
      target = kind;
    }
    const read = convertQuickAddItem(item, target === 'event' ? 'event' : 'task');
    if (read.kind === 'event') {
      eventModel.applyPrefill(read.prefill);
    } else {
      taskModel.applyPrefill(read.prefill);
    }
  };

  return {
    apply,
    /** The kinds the control offers, in its order; one entry means no control. */
    available,
    kind,
    mode,
    /** Both to-do kinds are disabled: an occurrence-scoped series edit cannot convert. */
    seriesOnly,
    switchTo,
  };
};
