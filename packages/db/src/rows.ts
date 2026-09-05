import {
  Account,
  Attendee,
  CalendarInfo,
  EventRecord,
  PendingOp,
  SyncState,
  TaskListInfo,
  TaskRecord,
} from '@calendar/core';
import { Schema } from 'effect';

/* eslint-disable perfectionist/sort-interfaces -- rows mirror column order */

export interface AccountRow {
  readonly id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly avatar_url: string | null;
  readonly status: string;
  readonly created_at: number;
  readonly tasks_enabled: number;
  readonly provider: string;
}

export const accountFromRow = (row: AccountRow): Account =>
  new Account({
    avatarUrl: row.avatar_url ?? undefined,
    createdAt: row.created_at,
    displayName: row.display_name ?? undefined,
    email: row.email,
    id: row.id,
    provider: row.provider === 'apple' ? 'apple' : 'google',
    status: row.status as 'ok' | 'reauth_required',
    tasksEnabled: row.tasks_enabled === 1,
  });

export interface TaskListRow {
  readonly account_id: string;
  readonly id: string;
  readonly title: string;
  readonly is_visible: number;
  readonly synced_at: number;
  readonly provider: string;
  readonly color_hex: string | null;
  readonly read_only: number;
}

export const taskListFromRow = (row: TaskListRow): TaskListInfo =>
  new TaskListInfo({
    accountId: row.account_id,
    colorHex: row.color_hex ?? undefined,
    id: row.id,
    isVisible: row.is_visible === 1,
    provider: row.provider === 'apple' ? 'apple' : 'google',
    ...(row.read_only === 1 ? { readOnly: true } : {}),
    title: row.title,
  });

export interface TaskRow {
  readonly account_id: string;
  readonly list_id: string;
  readonly id: string;
  readonly sync_status: string;
  readonly title: string;
  readonly notes: string | null;
  readonly status: string;
  readonly due_date: string | null;
  readonly completed_at: number | null;
  readonly web_view_link: string | null;
  readonly updated_at: number;
  readonly synced_at: number;
  readonly due_time: string | null;
  readonly priority: string | null;
  readonly url: string | null;
  readonly alarms: string | null;
  readonly recurrence: string | null;
  /** Joined from task_lists.provider by getWindow; plain SELECTs leave it absent (= google). */
  readonly list_provider?: string | null;
}

const parseJson = (text: string | null): unknown => {
  if (text === null) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const isPriority = (value: string | null): value is TaskRecord['priority'] & string =>
  value === 'high' || value === 'medium' || value === 'low';

export const taskFromRow = (row: TaskRow): TaskRecord => {
  const alarms = parseJson(row.alarms);
  const recurrence = parseJson(row.recurrence) as
    | { readonly freq?: string; readonly unsupported?: boolean }
    | undefined;
  const unsupported = recurrence?.unsupported === true;
  return new TaskRecord({
    accountId: row.account_id,
    ...(Array.isArray(alarms) ? { alarms: alarms as ReadonlyArray<number> } : {}),
    completedAt: row.completed_at ?? undefined,
    dueDate: row.due_date ?? undefined,
    dueTime: row.due_time ?? undefined,
    id: row.id,
    listId: row.list_id,
    notes: row.notes ?? undefined,
    ...(isPriority(row.priority) ? { priority: row.priority } : {}),
    provider: row.list_provider === 'apple' ? 'apple' : 'google',
    ...(recurrence && !unsupported && recurrence.freq
      ? { recurrence: recurrence as TaskRecord['recurrence'] }
      : {}),
    ...(unsupported ? { recurrenceUnsupported: true as const } : {}),
    status: row.status as TaskRecord['status'],
    title: row.title,
    updatedAt: row.updated_at,
    url: row.url ?? undefined,
    webViewLink: row.web_view_link ?? undefined,
  });
};

/** Column encoding for the JSON task fields (shared by insert + upsert). */
export const taskJsonColumns = (
  task: TaskRecord,
): { alarms: string | null; recurrence: string | null } => ({
  alarms: task.alarms === undefined ? null : JSON.stringify(task.alarms),
  recurrence: task.recurrenceUnsupported
    ? JSON.stringify({ unsupported: true })
    : task.recurrence === undefined
      ? null
      : JSON.stringify(task.recurrence),
});

export interface CalendarRow {
  readonly account_id: string;
  readonly id: string;
  readonly summary: string;
  readonly color_hex: string;
  readonly access_role: string;
  readonly is_primary: number;
  readonly is_visible: number;
  readonly time_zone: string;
}

export const calendarFromRow = (row: CalendarRow): CalendarInfo =>
  new CalendarInfo({
    accessRole: row.access_role as CalendarInfo['accessRole'],
    accountId: row.account_id,
    colorHex: row.color_hex,
    id: row.id,
    isPrimary: row.is_primary === 1,
    isVisible: row.is_visible === 1,
    summary: row.summary,
    timeZone: row.time_zone,
  });

export interface EventRow {
  readonly account_id: string;
  readonly calendar_id: string;
  readonly id: string;
  readonly etag: string | null;
  readonly status: string;
  readonly title: string;
  readonly location: string | null;
  readonly description: string | null;
  readonly is_all_day: number;
  readonly start_utc: number;
  readonly end_utc: number;
  readonly start_date: string | null;
  readonly end_date: string | null;
  readonly start_time_zone: string | null;
  readonly recurrence: string | null;
  readonly recurring_event_id: string | null;
  readonly original_start_utc: number | null;
  readonly attendees: string | null;
  readonly hangout_link: string | null;
  readonly organizer_email: string | null;
  readonly sync_status: string;
  readonly updated_at: number;
  readonly synced_at: number;
}

const attendeesJson = Schema.Array(Attendee);

export const eventFromRow = (row: EventRow): EventRecord =>
  new EventRecord({
    accountId: row.account_id,
    attendees: row.attendees
      ? Schema.decodeUnknownSync(attendeesJson)(JSON.parse(row.attendees))
      : undefined,
    calendarId: row.calendar_id,
    description: row.description ?? undefined,
    endDate: row.end_date ?? undefined,
    endUtc: row.end_utc,
    etag: row.etag,
    hangoutLink: row.hangout_link ?? undefined,
    id: row.id,
    isAllDay: row.is_all_day === 1,
    location: row.location ?? undefined,
    organizerEmail: row.organizer_email ?? undefined,
    originalStartUtc: row.original_start_utc ?? undefined,
    recurrence: row.recurrence ? (JSON.parse(row.recurrence) as Array<string>) : undefined,
    recurringEventId: row.recurring_event_id ?? undefined,
    startDate: row.start_date ?? undefined,
    startTimeZone: row.start_time_zone ?? undefined,
    startUtc: row.start_utc,
    status: row.status as EventRecord['status'],
    syncedAt: row.synced_at,
    syncStatus: row.sync_status as EventRecord['syncStatus'],
    title: row.title,
    updatedAt: row.updated_at,
  });

export const eventToRow = (event: EventRecord): EventRow => ({
  account_id: event.accountId,
  attendees: event.attendees
    ? JSON.stringify(Schema.encodeSync(attendeesJson)(event.attendees))
    : null,
  calendar_id: event.calendarId,
  description: event.description ?? null,
  end_date: event.endDate ?? null,
  end_utc: event.endUtc,
  etag: event.etag,
  hangout_link: event.hangoutLink ?? null,
  id: event.id,
  is_all_day: event.isAllDay ? 1 : 0,
  location: event.location ?? null,
  organizer_email: event.organizerEmail ?? null,
  original_start_utc: event.originalStartUtc ?? null,
  recurrence: event.recurrence ? JSON.stringify(event.recurrence) : null,
  recurring_event_id: event.recurringEventId ?? null,
  start_date: event.startDate ?? null,
  start_time_zone: event.startTimeZone ?? null,
  start_utc: event.startUtc,
  status: event.status,
  sync_status: event.syncStatus,
  synced_at: event.syncedAt,
  title: event.title,
  updated_at: event.updatedAt,
});

export interface PendingOpRow {
  readonly id: string;
  readonly account_id: string;
  readonly calendar_id: string;
  readonly kind: string;
  readonly event_id: string;
  readonly payload: string | null;
  readonly base_etag: string | null;
  readonly attempts: number;
  readonly next_attempt_at: number;
  readonly last_error: string | null;
  readonly created_at: number;
  readonly color_hex: string | null;
  readonly task_list_id: string | null;
  readonly task_status: string | null;
  readonly task_title: string | null;
  readonly task_notes: string | null;
  readonly task_due: string | null;
  readonly dispatched_at: number | null;
}

export const pendingOpFromRow = (row: PendingOpRow): PendingOp =>
  new PendingOp({
    accountId: row.account_id,
    attempts: row.attempts,
    baseEtag: row.base_etag ?? undefined,
    calendarId: row.calendar_id,
    colorHex: row.color_hex ?? undefined,
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at ?? undefined,
    eventId: row.event_id,
    id: row.id,
    kind: row.kind as PendingOp['kind'],
    lastError: row.last_error ?? undefined,
    nextAttemptAt: row.next_attempt_at,
    payload: row.payload
      ? Schema.decodeUnknownSync(EventRecord)(JSON.parse(row.payload))
      : undefined,
    taskDue: row.task_due ?? undefined,
    taskListId: row.task_list_id ?? undefined,
    taskNotes: row.task_notes ?? undefined,
    taskStatus: (row.task_status ?? undefined) as PendingOp['taskStatus'],
    taskTitle: row.task_title ?? undefined,
  });

export interface SyncStateRow {
  readonly account_id: string;
  readonly scope: string;
  readonly sync_token: string | null;
  readonly last_full_sync_at: number | null;
  readonly last_sync_at: number | null;
  readonly status: string;
}

export const syncStateFromRow = (row: SyncStateRow): SyncState =>
  new SyncState({
    accountId: row.account_id,
    lastFullSyncAt: row.last_full_sync_at,
    lastSyncAt: row.last_sync_at,
    scope: row.scope,
    status: row.status as SyncState['status'],
    syncToken: row.sync_token,
  });
