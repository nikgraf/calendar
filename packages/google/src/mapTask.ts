import { TaskListInfo, TaskRecord, Temporal } from '@calendar/core';
import type { GcalTask, GcalTaskList } from './apiTypes.ts';

const TASK_STATUSES = new Set(['completed', 'needsAction']);

/**
 * Converts a Google task resource into the domain record. Returns null for
 * tombstones (`deleted`) — the caller removes those rows instead.
 * `due` is RFC 3339 but the API discards its time portion, so the first
 * ten characters are the whole truth.
 */
export const mapGcalTask = (
  task: GcalTask,
  context: { readonly accountId: string; readonly taskListId: string },
): TaskRecord | null => {
  if (task.deleted) {
    return null;
  }
  const status = TASK_STATUSES.has(task.status ?? '')
    ? (task.status as 'completed' | 'needsAction')
    : 'needsAction';
  const completedAt = task.completed
    ? Temporal.Instant.from(task.completed).epochMilliseconds
    : undefined;
  return new TaskRecord({
    accountId: context.accountId,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(task.due ? { dueDate: task.due.slice(0, 10) } : {}),
    id: task.id,
    listId: context.taskListId,
    ...(task.notes ? { notes: task.notes } : {}),
    provider: 'google',
    status,
    title: task.title ?? '(untitled)',
    updatedAt: task.updated ? Temporal.Instant.from(task.updated).epochMilliseconds : 0,
    ...(task.webViewLink ? { webViewLink: task.webViewLink } : {}),
  });
};

export const mapGcalTaskList = (
  list: GcalTaskList,
  context: { readonly accountId: string },
): TaskListInfo =>
  new TaskListInfo({
    accountId: context.accountId,
    id: list.id,
    // Pull-side default; upsertLists preserves an existing local toggle.
    isVisible: true,
    provider: 'google',
    title: list.title ?? '(untitled list)',
  });
