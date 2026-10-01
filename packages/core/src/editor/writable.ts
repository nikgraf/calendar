import type { CalendarInfo, TaskListInfo } from '../types.ts';

/**
 * Whether the provider lets us write events into a calendar: Google's
 * owner/writer roles, or an Apple calendar EventKit allows modifications
 * on (mapped to 'owner'). An unknown calendar is not writable.
 */
export const isCalendarWritable = (
  calendar: Pick<CalendarInfo, 'accessRole'> | null | undefined,
): boolean => calendar?.accessRole === 'owner' || calendar?.accessRole === 'writer';

/** Whether the provider lets us write tasks into a list (only Reminders lists can be read-only). */
export const isTaskListWritable = (
  list: Pick<TaskListInfo, 'readOnly'> | null | undefined,
): boolean => list !== null && list !== undefined && list.readOnly !== true;
