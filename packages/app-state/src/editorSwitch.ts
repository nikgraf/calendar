import {
  type EventToTaskPreview,
  eventToTaskLoss,
  eventToTaskLossSummary,
  eventValuesToTaskValues,
  isEventToTaskLossy,
  isTaskToEventLossy,
  type PreviewEventToTaskParams,
  taskToEventLoss,
  taskToEventLossSummary,
  taskValuesToEventValues,
} from '@calendar/core';
import type { EditorConfirmRequest, useEventEditorModel } from './editorModel.ts';
import type { useTaskEditorModel } from './taskEditorModel.ts';

/** What the editor was opened with: a chip's item, or nothing (create mode). */
export type EditorSourceKind = 'birthday' | 'event' | 'new' | 'task';

/**
 * The Event | Task toggle, shared by both shells. Flipping carries the
 * current form over to the other editor. In create mode it asks first
 * when a filled field has no home on the other side (Save would
 * otherwise drop it silently; both models stay mounted, so flipping
 * back finds the old state). For an existing item nothing is asked
 * here: Save previews the stored record against the list or calendar
 * picked by then. Flipping back to the kind the item already is only
 * changes the mode, so the original form is untouched. Resolves whether
 * the mode changed.
 */
export const switchEditorMode = async ({
  confirm,
  eventModel,
  next,
  previewEventToTask,
  sourceKind,
  taskModel,
  timeZone,
}: {
  readonly confirm: (request: EditorConfirmRequest) => Promise<boolean>;
  readonly eventModel: ReturnType<typeof useEventEditorModel>;
  readonly next: 'event' | 'task';
  /** The backend preview, which carries a series' rule: an occurrence never has its master's lines. */
  readonly previewEventToTask: (params: PreviewEventToTaskParams) => Promise<EventToTaskPreview>;
  readonly sourceKind: EditorSourceKind;
  readonly taskModel: ReturnType<typeof useTaskEditorModel>;
  readonly timeZone: string;
}): Promise<boolean> => {
  if (next === 'task' && sourceKind !== 'task') {
    const source = eventModel.values();
    if (sourceKind === 'new') {
      const loss = eventToTaskLoss(source, taskModel.provider, 0);
      const summary = eventToTaskLossSummary(loss, 'Switching to a task');
      if (
        isEventToTaskLossy(loss) &&
        summary &&
        !(await confirm({ kind: 'switch', subject: 'event', summary }))
      ) {
        return false;
      }
    }
    const carried = eventValuesToTaskValues(source, taskModel.provider, timeZone);
    const event = eventModel.existing;
    const [accountId = '', taskListId = ''] = taskModel.listKey.split(':', 2);
    const recurrence =
      event && eventModel.isRecurring
        ? (
            await previewEventToTask({
              accountId: event.accountId,
              calendarId: event.calendarId,
              eventId: event.recurringEventId ?? event.id,
              target: { accountId, taskListId },
            })
          ).carriedRecurrence
        : carried.recurrence;
    taskModel.adopt({ ...carried, recurrence });
    return true;
  }
  if (next === 'event' && sourceKind !== 'event') {
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
        !(await confirm({ kind: 'switch', subject: 'task', summary }))
      ) {
        return false;
      }
    }
    eventModel.adopt(taskValuesToEventValues(source, eventModel.targetProvider));
  }
  return true;
};
