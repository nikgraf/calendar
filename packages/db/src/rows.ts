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
}

export const accountFromRow = (row: AccountRow): Account =>
  new Account({
    avatarUrl: row.avatar_url ?? undefined,
    createdAt: row.created_at,
    displayName: row.display_name ?? undefined,
    email: row.email,
    id: row.id,
    status: row.status as 'ok' | 'reauth_required',
    tasksEnabled: row.tasks_enabled === 1,
  });

export interface TaskListRow {
  readonly account_id: string;
  readonly id: string;
  readonly title: string;
  readonly is_visible: number;
  readonly synced_at: number;
}

export const taskListFromRow = (row: TaskListRow): TaskListInfo =>
  new TaskListInfo({
    accountId: row.account_id,
    id: row.id,
    isVisible: row.is_visible === 1,
    title: row.title,
  });

export interface TaskRow {
  readonly account_id: string;
  readonly list_id: string;
  readonly id: string;
  readonly title: string;
  readonly notes: string | null;
  readonly status: string;
  readonly due_date: string | null;
  readonly completed_at: number | null;
  readonly web_view_link: string | null;
  readonly updated_at: number;
  readonly synced_at: number;
}

export const taskFromRow = (row: TaskRow): TaskRecord =>
  new TaskRecord({
    accountId: row.account_id,
    completedAt: row.completed_at ?? undefined,
    dueDate: row.due_date ?? undefined,
    id: row.id,
    listId: row.list_id,
    notes: row.notes ?? undefined,
    status: row.status as TaskRecord['status'],
    title: row.title,
    updatedAt: row.updated_at,
    webViewLink: row.web_view_link ?? undefined,
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
}

export const pendingOpFromRow = (row: PendingOpRow): PendingOp =>
  new PendingOp({
    accountId: row.account_id,
    attempts: row.attempts,
    baseEtag: row.base_etag ?? undefined,
    calendarId: row.calendar_id,
    colorHex: row.color_hex ?? undefined,
    createdAt: row.created_at,
    eventId: row.event_id,
    id: row.id,
    kind: row.kind as PendingOp['kind'],
    lastError: row.last_error ?? undefined,
    nextAttemptAt: row.next_attempt_at,
    payload: row.payload
      ? Schema.decodeUnknownSync(EventRecord)(JSON.parse(row.payload))
      : undefined,
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
