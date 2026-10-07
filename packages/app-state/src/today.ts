import {
  addDaysToPlainDate,
  groupTaskInbox,
  Temporal,
  type TaskInbox,
  type UpNext,
  upNext,
} from '@calendar/core';
import { useMemo } from 'react';
import {
  useEventsInRangeStable,
  useNow,
  useOverdueTasksStable,
  useTasksInRangeStable,
  useToday,
} from './hooks.ts';

const HOUR_MS = 3_600_000;
/** How far ahead the inbox's "upcoming" looks. */
export const TASK_INBOX_DAYS = 30;

/**
 * The event to show as "up next" (`upNext` in core) over today and the
 * following morning, kept fresh by the minute. Reads its own window, so it
 * is right whichever week or month the calendar is showing.
 */
export const useUpNext = (timeZone: string): UpNext | undefined => {
  const today = useToday(timeZone);
  const now = useNow();
  const start = Temporal.PlainDate.from(today).toZonedDateTime({ timeZone }).epochMilliseconds;
  const events = useEventsInRangeStable(start, start + 36 * HOUR_MS);
  return useMemo(() => upNext(events, now), [events, now]);
};

/**
 * The task inbox: today's, the late ones, the undated ones, the next
 * month's and those finished today (`groupTaskInbox` in core).
 */
export const useTaskInbox = (timeZone: string): TaskInbox => {
  const today = useToday(timeZone);
  const tasks = useTasksInRangeStable(today, addDaysToPlainDate(today, TASK_INBOX_DAYS));
  const overdue = useOverdueTasksStable(today);
  return useMemo(
    () => groupTaskInbox([...tasks, ...overdue], today, timeZone),
    [tasks, overdue, today, timeZone],
  );
};
