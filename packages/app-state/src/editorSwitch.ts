import {
  defaultTodoList,
  type EventToTaskPreview,
  eventToTaskLoss,
  eventToTaskLossSummary,
  eventValuesToTaskValues,
  isEventToTaskLossy,
  isTaskMoveLossy,
  isTaskToEventLossy,
  type ItemKind,
  type PreviewEventToTaskParams,
  taskListKeyOf,
  taskMoveLoss,
  taskMoveLossSummary,
  taskToEventLoss,
  taskToEventLossSummary,
  taskValuesToEventValues,
  todoKindOf,
  todoProviderOf,
} from '@calendar/core';
import type { EditorConfirmRequest, useEventEditorModel } from './editorModel.ts';
import { getLastUsedTaskListKey, type useTaskEditorModel } from './taskEditorModel.ts';

/** What the editor was opened with: a chip's item, or nothing (create mode). */
export type EditorSourceKind = 'birthday' | 'event' | 'new' | 'task';

/** Which model the editor shows: the event form, or the task model (a task or a reminder). */
export type EditorMode = 'event' | 'todo';

/**
 * The Event | Task | Reminder switch, shared by both shells. Flipping
 * between the event form and the task model carries the current form
 * over; flipping between Task and Reminder keeps the task model's fields
 * and picks a list of the other provider (the kind's default list). In
 * create mode it asks first when a filled field has no home on the other
 * side (Save would otherwise drop it silently; both models stay mounted,
 * so flipping back finds the old state). For an existing item nothing is
 * asked here: Save previews the stored record against the list or
 * calendar picked by then. Flipping back to the kind the item already is
 * only changes the mode, so the original form is untouched. Resolves
 * whether the mode changed.
 */
export const switchEditorMode = async ({
  confirm,
  eventModel,
  from,
  next,
  previewEventToTask,
  sourceKind,
  taskModel,
  timeZone,
}: {
  readonly confirm: (request: EditorConfirmRequest) => Promise<boolean>;
  readonly eventModel: ReturnType<typeof useEventEditorModel>;
  /** The mode the editor shows now. */
  readonly from: EditorMode;
  readonly next: ItemKind;
  /** The backend preview: it carries a series' rule and an Apple event's URL, which the record lacks. */
  readonly previewEventToTask: (params: PreviewEventToTaskParams) => Promise<EventToTaskPreview>;
  readonly sourceKind: EditorSourceKind;
  readonly taskModel: ReturnType<typeof useTaskEditorModel>;
  readonly timeZone: string;
}): Promise<boolean> => {
  if (next === 'event') {
    if (from === 'event') {
      return true;
    }
    if (sourceKind === 'event') {
      // Back to what it is: the event form was never touched.
      return true;
    }
    const source = taskModel.values();
    if (sourceKind === 'new') {
      const loss = taskToEventLoss({
        ...source,
        status: source.completed ? 'completed' : 'needsAction',
      });
      const summary = taskToEventLossSummary(loss, 'Switching to an event');
      if (
        isTaskToEventLossy(loss) &&
        summary &&
        !(await confirm({
          kind: 'switch',
          subject: todoKindOf(taskModel.provider),
          summary,
          target: 'event',
        }))
      ) {
        return false;
      }
    }
    eventModel.adopt(taskValuesToEventValues(source, eventModel.targetProvider));
    return true;
  }

  // A task or a reminder: the list decides the provider. A list already
  // picked for that provider stays (a round trip through the event form,
  // or the Tasks tab's filtered list); otherwise the kind's default list
  // is picked. The kind is only offered when one exists.
  const existingTask = taskModel.existing;
  const ownKind = existingTask ? todoKindOf(existingTask.provider) : undefined;
  const picked = taskModel.offeredLists.find(
    (list) => taskListKeyOf(list) === taskModel.listKey && list.provider === todoProviderOf(next),
  );
  const target =
    next === ownKind && existingTask
      ? undefined
      : (picked ??
        defaultTodoList(taskModel.offeredLists, {
          kind: next,
          lastUsedKey: getLastUsedTaskListKey(),
        }));
  const targetKey =
    next === ownKind && existingTask
      ? taskListKeyOf({ accountId: existingTask.accountId, id: existingTask.listId })
      : target
        ? taskListKeyOf(target)
        : undefined;
  if (targetKey === undefined) {
    return false;
  }

  if (from === 'todo') {
    // Task ↔ Reminder: the same form values on a list of the other
    // provider. A new reminder's time, alerts, priority and rule have no
    // home on a Google list (its URL folds into the notes); an existing
    // one moves on Save, which asks then.
    if (sourceKind === 'new' && next === 'task' && taskModel.provider === 'apple') {
      const values = taskModel.values();
      const loss = taskMoveLoss(
        {
          alarms: values.alarms,
          dueTime: values.dueTime,
          priority: values.priority,
          recurrence: values.recurrence,
        },
        { sameAccount: false, source: 'apple', target: 'google' },
      );
      const summary = taskMoveLossSummary(loss, 'Switching to a task');
      if (
        isTaskMoveLossy(loss) &&
        summary &&
        !(await confirm({ kind: 'switch', subject: 'reminder', summary, target: 'task' }))
      ) {
        return false;
      }
    }
    taskModel.setListKey(targetKey);
    return true;
  }

  if (sourceKind === 'task') {
    // Back from the event form to a to-do: the task form was never
    // touched; the other provider's list makes it a move on Save.
    taskModel.setListKey(targetKey);
    return true;
  }
  const source = eventModel.values();
  const provider = target?.provider ?? taskModel.provider;
  if (sourceKind === 'new') {
    const loss = eventToTaskLoss(source, provider, 0);
    const summary = eventToTaskLossSummary(loss, `Switching to a ${next}`);
    if (
      isEventToTaskLossy(loss) &&
      summary &&
      !(await confirm({ kind: 'switch', subject: 'event', summary, target: next }))
    ) {
      return false;
    }
  }
  const carried = eventValuesToTaskValues(source, timeZone);
  const event = eventModel.existing;
  if (event === undefined) {
    taskModel.adopt(carried);
    taskModel.setListKey(targetKey);
    return true;
  }
  // The stored event holds what the form never shows: a series' rule
  // (an occurrence row has no lines) and an Apple event's plain URL.
  const [accountId = '', taskListId = ''] = targetKey.split(':', 2);
  const preview = await previewEventToTask({
    accountId: event.accountId,
    calendarId: event.calendarId,
    eventId: event.recurringEventId ?? event.id,
    target: { accountId, taskListId },
  });
  taskModel.adopt({
    ...carried,
    recurrence: preview.carriedRecurrence,
    url: carried.url ?? preview.carriedUrl,
  });
  taskModel.setListKey(targetKey);
  return true;
};
