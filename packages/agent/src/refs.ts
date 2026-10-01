import type { EventRecord, TaskRecord } from '@calendar/core';

/**
 * What an agent holds instead of ids. Calendar and event ids are unique
 * only within an account, and one occurrence of a series needs its master
 * and slot as well — so every item an agent can name is one opaque string
 * that carries the full key. The gateway never trusts the calendar or list
 * inside a ref: it resolves the item's real container before authorizing.
 */
export type ItemRef =
  | { readonly accountId: string; readonly calendarId: string; readonly kind: 'calendar' }
  | {
      readonly accountId: string;
      readonly calendarId: string;
      readonly eventId: string;
      readonly kind: 'event';
    }
  | {
      readonly accountId: string;
      readonly calendarId: string;
      readonly kind: 'occurrence';
      readonly masterId: string;
      readonly originalStartUtc: number;
    }
  | {
      readonly accountId: string;
      readonly kind: 'task';
      readonly taskId: string;
      readonly taskListId: string;
    }
  | { readonly accountId: string; readonly kind: 'taskList'; readonly taskListId: string };

export type CalendarRef = Extract<ItemRef, { kind: 'calendar' }>;
export type EventRef = Extract<ItemRef, { kind: 'event' | 'occurrence' }>;
export type TaskRef = Extract<ItemRef, { kind: 'task' }>;
export type TaskListRef = Extract<ItemRef, { kind: 'taskList' }>;

const PREFIX = { calendar: 'cal_', event: 'evt_', task: 'task_', taskList: 'list_' } as const;

const toBase64Url = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

const fromBase64Url = (encoded: string): string | undefined => {
  if (!/^[\w-]+$/u.test(encoded)) {
    return undefined;
  }
  try {
    const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

const pack = (prefix: string, parts: ReadonlyArray<number | string>): string =>
  `${prefix}${toBase64Url(JSON.stringify(parts))}`;

export const encodeRef = (ref: ItemRef): string => {
  switch (ref.kind) {
    case 'calendar': {
      return pack(PREFIX.calendar, [ref.accountId, ref.calendarId]);
    }
    case 'event': {
      return pack(PREFIX.event, [ref.accountId, ref.calendarId, ref.eventId]);
    }
    case 'occurrence': {
      return pack(PREFIX.event, [
        ref.accountId,
        ref.calendarId,
        ref.masterId,
        ref.originalStartUtc,
      ]);
    }
    case 'task': {
      return pack(PREFIX.task, [ref.accountId, ref.taskListId, ref.taskId]);
    }
    case 'taskList': {
      return pack(PREFIX.taskList, [ref.accountId, ref.taskListId]);
    }
  }
};

const unpack = (value: string, prefix: string): ReadonlyArray<unknown> | undefined => {
  if (!value.startsWith(prefix)) {
    return undefined;
  }
  const json = fromBase64Url(value.slice(prefix.length));
  if (json === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export const decodeCalendarRef = (value: string): CalendarRef | undefined => {
  const parts = unpack(value, PREFIX.calendar);
  const [accountId, calendarId] = parts ?? [];
  return parts?.length === 2 && isText(accountId) && isText(calendarId)
    ? { accountId, calendarId, kind: 'calendar' }
    : undefined;
};

export const decodeTaskListRef = (value: string): TaskListRef | undefined => {
  const parts = unpack(value, PREFIX.taskList);
  const [accountId, taskListId] = parts ?? [];
  return parts?.length === 2 && isText(accountId) && isText(taskListId)
    ? { accountId, kind: 'taskList', taskListId }
    : undefined;
};

export const decodeEventRef = (value: string): EventRef | undefined => {
  const parts = unpack(value, PREFIX.event);
  const [accountId, calendarId, id, slot] = parts ?? [];
  if (!isText(accountId) || !isText(calendarId) || !isText(id)) {
    return undefined;
  }
  if (parts?.length === 3) {
    return { accountId, calendarId, eventId: id, kind: 'event' };
  }
  return parts?.length === 4 && typeof slot === 'number' && Number.isFinite(slot)
    ? { accountId, calendarId, kind: 'occurrence', masterId: id, originalStartUtc: slot }
    : undefined;
};

export const decodeTaskRef = (value: string): TaskRef | undefined => {
  const parts = unpack(value, PREFIX.task);
  const [accountId, taskListId, taskId] = parts ?? [];
  return parts?.length === 3 && isText(accountId) && isText(taskListId) && isText(taskId)
    ? { accountId, kind: 'task', taskId, taskListId }
    : undefined;
};

/**
 * The ref of an event as a range read returns it. An occurrence (expanded
 * or a stored exception) is named by its master and slot — never by
 * parsing the record id, since Google's own exception ids contain
 * underscores too.
 */
export const eventRefOf = (event: EventRecord): EventRef =>
  event.recurringEventId === undefined
    ? {
        accountId: event.accountId,
        calendarId: event.calendarId,
        eventId: event.id,
        kind: 'event',
      }
    : {
        accountId: event.accountId,
        calendarId: event.calendarId,
        kind: 'occurrence',
        masterId: event.recurringEventId,
        originalStartUtc: event.originalStartUtc ?? event.startUtc,
      };

export const taskRefOf = (task: TaskRecord): TaskRef => ({
  accountId: task.accountId,
  kind: 'task',
  taskId: task.id,
  taskListId: task.listId,
});
