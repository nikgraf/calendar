import type { QuickAddTaskPrefill } from '@calendar/ai';
import {
  buildEventTimes,
  buildRecurrenceRule,
  type EventDraft,
  type TaskListInfo,
} from '@calendar/core';
import type { EventEditorPrefill } from './editorModel.ts';

/**
 * The create draft for a quick-add phrase taken as understood — the
 * review card's "Add event": no editor, the same draft the editor would
 * have saved untouched.
 */
export const eventDraftFromPrefill = (
  prefill: EventEditorPrefill,
  calendar: { readonly accountId: string; readonly calendarId: string },
  timeZone: string,
): EventDraft => ({
  accountId: calendar.accountId,
  calendarId: calendar.calendarId,
  isAllDay: prefill.isAllDay,
  ...(prefill.location ? { location: prefill.location } : {}),
  ...(prefill.recurrence
    ? {
        recurrence: [
          buildRecurrenceRule(
            { ...prefill.recurrence, interval: prefill.recurrence.interval ?? 1 },
            prefill.isAllDay,
            timeZone,
          ),
        ],
      }
    : {}),
  title: prefill.title,
  ...buildEventTimes(
    {
      date: prefill.date,
      endTime: prefill.endTime,
      isAllDay: prefill.isAllDay,
      startTime: prefill.startTime,
    },
    timeZone,
  ),
});

/** The create params for a phrase understood as a to-do; only a Reminders list keeps the time. */
export const taskParamsFromPrefill = (
  prefill: QuickAddTaskPrefill,
  list: Pick<TaskListInfo, 'accountId' | 'id' | 'provider'>,
): {
  readonly accountId: string;
  readonly dueDate: string;
  readonly dueTime?: string;
  readonly taskListId: string;
  readonly title: string;
} => ({
  accountId: list.accountId,
  dueDate: prefill.date,
  ...(list.provider === 'apple' && prefill.time ? { dueTime: prefill.time } : {}),
  taskListId: list.id,
  title: prefill.title,
});
