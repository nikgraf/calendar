import {
  Account,
  Attendee,
  CalendarInfo,
  CarriedText,
  Contact,
  CopySource,
  engineRecurrenceLines,
  engineZoneId,
  EventRecord,
  EventReminders,
  GeoLocation,
  GoogleBirthday,
  PendingOp,
  projectInstance,
  recurrenceEndUtc,
  ReminderOverride,
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
  readonly contacts_enabled: number;
}

export const accountFromRow = (row: AccountRow): Account =>
  new Account({
    avatarUrl: row.avatar_url ?? undefined,
    contactsEnabled: row.contacts_enabled === 1,
    createdAt: row.created_at,
    displayName: row.display_name ?? undefined,
    email: row.email,
    id: row.id,
    provider: row.provider === 'apple' ? 'apple' : 'google',
    status: row.status === 'reauth_required' ? 'reauth_required' : 'ok',
    tasksEnabled: row.tasks_enabled === 1,
  });

export interface ContactRow {
  readonly account_id: string;
  readonly resource_name: string;
  readonly email_lower: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly is_other: number;
  readonly synced_at: number;
}

export const contactFromRow = (row: ContactRow): Contact =>
  new Contact({
    accountId: row.account_id,
    displayName: row.display_name ?? undefined,
    email: row.email,
    id: `google:${row.account_id}:${row.resource_name}:${row.email_lower}`,
    isOtherContact: row.is_other === 1,
    source: 'google',
  });

export interface ContactBirthdayRow {
  readonly account_id: string;
  readonly resource_name: string;
  readonly display_name: string;
  readonly month: number;
  readonly day: number;
  readonly year: number | null;
  readonly synced_at: number;
}

export const googleBirthdayFromRow = (row: ContactBirthdayRow): GoogleBirthday =>
  new GoogleBirthday({
    accountId: row.account_id,
    day: row.day,
    displayName: row.display_name,
    month: row.month,
    resourceName: row.resource_name,
    year: row.year ?? undefined,
  });

export interface DeviceSettingRow {
  readonly key: string;
  readonly value: string;
  readonly updated_at: number;
}

export interface LocationGeoRow {
  readonly location_key: string;
  readonly geo: string | null;
  readonly resolved_at: number;
}

/** A cache row's GeoLocation, or null for a recorded miss (or an unreadable value). */
export const locationGeoFromRow = (row: LocationGeoRow): GeoLocation | null =>
  decodeOr(GeoLocation, parseJson(row.geo)) ?? null;

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
  /** Reminders only. */
  readonly external_id: string | null;
  readonly due_utc: number | null;
  /** Google only. */
  readonly parent_id: string | null;
  readonly position: string | null;
  /** Joined from task_lists.provider by getWindow; plain SELECTs leave it absent (= google). */
  readonly list_provider?: string | null;
}

export const parseJson = (text: string | null): unknown => {
  if (text === null) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Tolerant decode for a JSON column: an undecodable value degrades to
 * `undefined` instead of throwing out of a row mapper. A throw here used
 * to escape `listAll()` — which runs on every mutation and behind the
 * unsynced-changes panel — so one stale payload bricked every write and
 * the very UI that could discard it.
 */
const decodeOr = <A>(schema: Schema.Codec<A, unknown>, value: unknown): A | undefined => {
  if (value === undefined) {
    return undefined;
  }
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    return undefined;
  }
};

/** A column that must hold one of a few literals: unknown values take the fallback. */
const oneOf = <T extends string>(allowed: ReadonlySet<string>, value: string, fallback: T): T =>
  allowed.has(value) ? (value as T) : fallback;

const EVENT_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'confirmed', 'tentative']);
const SYNC_STATUSES: ReadonlySet<string> = new Set(['error', 'pending', 'synced']);
const TASK_STATUSES: ReadonlySet<string> = new Set(['completed', 'needsAction']);
const TRANSPARENCIES: ReadonlySet<string> = new Set(['opaque', 'transparent']);
const VISIBILITIES: ReadonlySet<string> = new Set(['confidential', 'default', 'private', 'public']);
const ACCESS_ROLES: ReadonlySet<string> = new Set(['freeBusyReader', 'owner', 'reader', 'writer']);
const OP_KINDS: ReadonlySet<string> = new Set([
  'calendarColor',
  'completeTask',
  'create',
  'createTask',
  'delete',
  'deleteTask',
  'move',
  'moveTask',
  'reorderTask',
  'rsvp',
  'update',
  'updateTask',
]);

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
    dueUtc: row.due_utc ?? undefined,
    externalId: row.external_id ?? undefined,
    id: row.id,
    listId: row.list_id,
    notes: row.notes ?? undefined,
    parentId: row.parent_id ?? undefined,
    position: row.position ?? undefined,
    ...(isPriority(row.priority) ? { priority: row.priority } : {}),
    provider: row.list_provider === 'apple' ? 'apple' : 'google',
    ...(recurrence && !unsupported && recurrence.freq
      ? { recurrence: recurrence as TaskRecord['recurrence'] }
      : {}),
    ...(unsupported ? { recurrenceUnsupported: true as const } : {}),
    status: oneOf<TaskRecord['status']>(TASK_STATUSES, row.status, 'needsAction'),
    title: row.title,
    updatedAt: row.updated_at,
    url: row.url ?? undefined,
    webViewLink: row.web_view_link ?? undefined,
  });
};

/** Column encoding for the JSON task fields (shared by insert + upsert). */
/** A task stored as JSON (a provider copy): undefined when it does not decode. */
export const taskFromPayload = (text: string | null): TaskRecord | undefined =>
  decodeOr(TaskRecord, parseJson(text));

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
  /** Apple only: the EventKit source ("iCloud", "On My Mac"). */
  readonly source_title: string | null;
  /** JSON ReminderOverride[]. */
  readonly default_reminders: string | null;
  /** Joined from accounts.provider by CalendarRepo.list (not a calendars column). */
  readonly account_provider: string | null;
}

const remindersJson = Schema.Array(ReminderOverride);

/** Column encoding for a calendar's default reminders (NULL = none known). */
export const defaultRemindersJson = (calendar: CalendarInfo): string | null =>
  calendar.defaultReminders
    ? JSON.stringify(Schema.encodeSync(remindersJson)(calendar.defaultReminders))
    : null;

export const calendarFromRow = (row: CalendarRow): CalendarInfo =>
  new CalendarInfo({
    accessRole: oneOf<CalendarInfo['accessRole']>(ACCESS_ROLES, row.access_role, 'reader'),
    accountId: row.account_id,
    colorHex: row.color_hex,
    defaultReminders: decodeOr(remindersJson, parseJson(row.default_reminders)),
    id: row.id,
    isPrimary: row.is_primary === 1,
    isVisible: row.is_visible === 1,
    provider: row.account_provider === 'apple' ? 'apple' : 'google',
    sourceTitle: row.source_title ?? undefined,
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
  readonly recurrence_end_utc: number | null;
  readonly organizer_email: string | null;
  readonly sync_status: string;
  readonly updated_at: number;
  readonly synced_at: number;
  /** JSON GeoLocation. */
  readonly geo: string | null;
  /** JSON EventReminders. */
  readonly reminders: string | null;
  /** A mirror copy's marker. */
  readonly mirror: string | null;
  readonly transparency: string | null;
  readonly visibility: string | null;
}

const attendeesJson = Schema.Array(Attendee);

const stringArray = (value: unknown): Array<string> | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;

/**
 * A row's zones are read in the spelling this engine accepts: rows pulled
 * before mapEvent did that keep Google's (Hermes rejects Asia/Kolkata, so
 * such a series was left out of every view on iOS).
 */
const recurrenceOf = (stored: string | null): Array<string> | undefined => {
  const lines = stringArray(parseJson(stored));
  return lines && engineRecurrenceLines(lines);
};

export const eventFromRow = (row: EventRow): EventRecord =>
  new EventRecord({
    accountId: row.account_id,
    attendees: decodeOr(attendeesJson, parseJson(row.attendees)),
    calendarId: row.calendar_id,
    description: row.description ?? undefined,
    endDate: row.end_date ?? undefined,
    endUtc: row.end_utc,
    etag: row.etag,
    geo: decodeOr(GeoLocation, parseJson(row.geo)),
    hangoutLink: row.hangout_link ?? undefined,
    id: row.id,
    isAllDay: row.is_all_day === 1,
    location: row.location ?? undefined,
    mirror: row.mirror ?? undefined,
    organizerEmail: row.organizer_email ?? undefined,
    originalStartUtc: row.original_start_utc ?? undefined,
    recurrence: recurrenceOf(row.recurrence),
    recurringEventId: row.recurring_event_id ?? undefined,
    reminders: decodeOr(EventReminders, parseJson(row.reminders)),
    startDate: row.start_date ?? undefined,
    startTimeZone: row.start_time_zone === null ? undefined : engineZoneId(row.start_time_zone),
    startUtc: row.start_utc,
    status: oneOf<EventRecord['status']>(EVENT_STATUSES, row.status, 'confirmed'),
    syncedAt: row.synced_at,
    syncStatus: oneOf<EventRecord['syncStatus']>(SYNC_STATUSES, row.sync_status, 'synced'),
    title: row.title,
    transparency:
      row.transparency === null
        ? undefined
        : oneOf<NonNullable<EventRecord['transparency']>>(
            TRANSPARENCIES,
            row.transparency,
            'opaque',
          ),
    updatedAt: row.updated_at,
    visibility:
      row.visibility === null
        ? undefined
        : oneOf<NonNullable<EventRecord['visibility']>>(VISIBILITIES, row.visibility, 'default'),
  });

/** The `recurrence_end_utc` column: when a master's series ends, NULL for endless and singles. */
export const seriesEndUtc = (event: EventRecord): number | null =>
  event.recurrence && event.recurrence.length > 0
    ? (recurrenceEndUtc({
        endDate: event.endDate,
        endUtc: event.endUtc,
        id: event.id,
        isAllDay: event.isAllDay,
        recurrence: event.recurrence,
        startDate: event.startDate,
        startTimeZone: event.startTimeZone ?? 'UTC',
        startUtc: event.startUtc,
      }) ?? null)
    : null;

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
  geo: event.geo ? JSON.stringify(Schema.encodeSync(GeoLocation)(event.geo)) : null,
  hangout_link: event.hangoutLink ?? null,
  id: event.id,
  is_all_day: event.isAllDay ? 1 : 0,
  location: event.location ?? null,
  mirror: event.mirror ?? null,
  organizer_email: event.organizerEmail ?? null,
  original_start_utc: event.originalStartUtc ?? null,
  recurrence: event.recurrence ? JSON.stringify(event.recurrence) : null,
  // Computed on every write (sync pages, local edits, seeds) so the
  // window query can skip series that ended before the range.
  recurrence_end_utc: seriesEndUtc(event),
  recurring_event_id: event.recurringEventId ?? null,
  reminders: event.reminders
    ? JSON.stringify(Schema.encodeSync(EventReminders)(event.reminders))
    : null,
  start_date: event.startDate ?? null,
  start_time_zone: event.startTimeZone ?? null,
  start_utc: event.startUtc,
  status: event.status,
  sync_status: event.syncStatus,
  synced_at: event.syncedAt,
  title: event.title,
  transparency: event.transparency ?? null,
  updated_at: event.updatedAt,
  visibility: event.visibility ?? null,
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
  readonly discarded: number;
  readonly dispatched_at: number | null;
  readonly drops_from: number | null;
  readonly split_at: number | null;
  readonly source_gone: number;
  readonly split_check: number;
  readonly split_in: string | null;
  readonly split_of: string | null;
  readonly attendees_changed: number;
  readonly geo_cleared: number;
  readonly target_calendar_id: string | null;
  readonly reminders_changed: number;
  readonly conflict_at: number | null;
  readonly carried_text: string | null;
  readonly recurrence_cleared: number;
  readonly before_color_hex: string | null;
  readonly target_task_list_id: string | null;
  readonly task_parent: string | null;
  readonly task_due_cleared: number;
  readonly task_previous: string | null;
  readonly copy_source: string | null;
  /** What an update or an answer changed, against Google's copy (JSON `EventChanges`). */
  readonly changes: string | null;
  /** Google's copy of the op's event (`event_copies`), joined in by the repo's reads. */
  readonly copy_payload?: string | null;
  /** Joined in by PendingOpRepo: the copies a series delete holds (a JSON array). */
  readonly taken_payload?: string | null;
}

const eventListSchema = Schema.Array(EventRecord);

/** The op kinds that replace an event Google may have: the ones that read its copy. */
export const HOLDING_KINDS: ReadonlySet<string> = new Set(['delete', 'rsvp', 'update']);

/**
 * What an event op replaces: Google's copy of its event, kept once per
 * event beside the row (`event_copies`) and read by every queued op of
 * it. `null` when Google has none — an occurrence whose override the
 * change materialized, an event a pull saw removed — and undefined for
 * the op kinds that replace nothing.
 */
const beforePayloadOf = (row: PendingOpRow): EventRecord | null | undefined =>
  HOLDING_KINDS.has(row.kind)
    ? (decodeOr(EventRecord, parseJson(row.copy_payload ?? null)) ?? null)
    : undefined;

/**
 * What a queued update or answer changed: the fields that edit set, and
 * nothing else — not what an earlier change of the event set, which is
 * that change's. The version itself is not kept: it is Google's copy with
 * the changes queued for the event laid over it in queue order, up to this
 * one, computed at every read (`withEventChanges`). So a copy that moves
 * on under a waiting change takes the rest of the event with it, a change
 * that leaves the queue takes only its own fields along, and each change's
 * own fields stay. Encoded as the event's JSON is.
 */
export interface EventChanges {
  /** The answers that differ, by guest email. */
  readonly answers: Readonly<Record<string, string>>;
  /** Fields the user emptied. */
  readonly cleared: ReadonlyArray<string>;
  /** Fields the user set, with their values (the guest list only when it was edited). */
  readonly set: Readonly<Record<string, unknown>>;
}

/** Row bookkeeping: never a change. */
const NOT_A_CHANGE: ReadonlySet<string> = new Set([
  'accountId',
  'attendees',
  'calendarId',
  'etag',
  'id',
  'mirror',
  'syncStatus',
  'syncedAt',
  'updatedAt',
]);

/** Fields the user reads as one thing, and that are kept whole: a time, a place. */
const WHOLES: ReadonlyArray<ReadonlyArray<string>> = [
  ['endDate', 'endUtc', 'isAllDay', 'startDate', 'startTimeZone', 'startUtc'],
  ['geo', 'location'],
];

interface EncodedGuest {
  readonly email?: string;
  readonly responseStatus?: string;
}

const guestsOf = (event: Readonly<Record<string, unknown>>): ReadonlyArray<EncodedGuest> =>
  Array.isArray(event['attendees']) ? (event['attendees'] as ReadonlyArray<EncodedGuest>) : [];

/**
 * The changes that turn `copy` into `payload` (both encoded events).
 * `guests`: the op edited the guest list, which then goes whole. `kept`:
 * fields that are the op's whatever their value — it set them before, to
 * what `copy` may hold by now (a rename back to the old title while the
 * rename is out: left out, it was never sent).
 */
export const eventChangesOf = (
  copy: Readonly<Record<string, unknown>>,
  payload: Readonly<Record<string, unknown>>,
  guests: boolean,
  kept: ReadonlyArray<string> = [],
): EventChanges => {
  const differs = (key: string) => JSON.stringify(copy[key]) !== JSON.stringify(payload[key]);
  const changed = new Set(
    [...new Set([...Object.keys(copy), ...Object.keys(payload)])].filter(
      (key) => !NOT_A_CHANGE.has(key) && (differs(key) || kept.includes(key)),
    ),
  );
  for (const whole of WHOLES) {
    if (whole.some((key) => changed.has(key))) {
      for (const key of whole) {
        changed.add(key);
      }
    }
  }
  const set: Record<string, unknown> = {};
  const cleared: Array<string> = [];
  for (const key of [...changed].toSorted()) {
    if (payload[key] === undefined || payload[key] === null) {
      cleared.push(key);
    } else {
      set[key] = payload[key];
    }
  }
  if (guests) {
    set['attendees'] = payload['attendees'] ?? [];
  }
  const theirs = new Map(guestsOf(copy).map((guest) => [guest.email, guest.responseStatus]));
  const answers: Record<string, string> = {};
  for (const guest of guestsOf(payload)) {
    if (
      guest.email !== undefined &&
      guest.responseStatus !== undefined &&
      theirs.has(guest.email) &&
      theirs.get(guest.email) !== guest.responseStatus
    ) {
      answers[guest.email] = guest.responseStatus;
    }
  }
  return { answers, cleared, set };
};

/**
 * What an answer changes: the answers that differ, and those of the guests
 * it answers for (`kept`, by email) always — the first answer given again
 * while another is out differs from nothing here, and is the one that
 * counts. No other field: an answer owns none, and one it kept went on to
 * Google as the user's after the edit that set it was replaced.
 */
export const answerChangesOf = (
  copy: Readonly<Record<string, unknown>>,
  payload: Readonly<Record<string, unknown>>,
  kept: ReadonlyArray<string> = [],
): EventChanges => {
  const own: Record<string, string> = {};
  for (const guest of guestsOf(payload)) {
    if (
      guest.email !== undefined &&
      guest.responseStatus !== undefined &&
      kept.includes(guest.email)
    ) {
      own[guest.email] = guest.responseStatus;
    }
  }
  return {
    answers: { ...eventChangesOf(copy, payload, false).answers, ...own },
    cleared: [],
    set: {},
  };
};

/** `base` (an encoded event) with the changes queued ahead of an op over it, in their order. */
export const laidOver = (
  base: Readonly<Record<string, unknown>>,
  earlier: ReadonlyArray<EventChanges>,
): Readonly<Record<string, unknown>> =>
  earlier.reduce<Readonly<Record<string, unknown>>>(
    (event, changes) => withEventChanges(event, changes, undefined),
    base,
  );

/**
 * Google's copy with a queued op's changes over it: the user's version, as
 * an encoded event. `stored` is the version the op was queued with, which
 * dates it.
 */
export const withEventChanges = (
  copy: Readonly<Record<string, unknown>>,
  changes: EventChanges,
  stored: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> => {
  const event: Record<string, unknown> = { ...copy, ...changes.set };
  for (const key of changes.cleared) {
    delete event[key];
  }
  const guests = guestsOf(event);
  if (guests.length > 0) {
    event['attendees'] = guests.map((guest) => {
      const answer = guest.email === undefined ? undefined : changes.answers[guest.email];
      return answer === undefined ? guest : { ...guest, responseStatus: answer };
    });
  }
  return { ...event, syncStatus: 'pending', updatedAt: stored?.['updatedAt'] ?? copy['updatedAt'] };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEventChanges = (value: unknown): value is EventChanges =>
  isRecord(value) &&
  isRecord(value['answers']) &&
  Array.isArray(value['cleared']) &&
  isRecord(value['set']);

/** The stored changes of a queued op (`pending_ops.changes`), none when it keeps its version whole. */
export const eventChangesFrom = (json: string | null): EventChanges | undefined => {
  const changes = parseJson(json);
  return isEventChanges(changes) ? changes : undefined;
};

const CARRIED_FIELDS = ['description', 'location', 'title'] as const;

/**
 * What a queued series edit carried onto one of its exceptions, as changes
 * laid under that exception's own: Google copies a changed title,
 * description or location of a series onto every exception when the edit
 * lands, and the exception's row shows it already. Only while Google's
 * copy of the exception (`copy`, encoded) is the version the edit carried
 * onto — a newer one is Google's word, and shows its own text until the
 * edit lands. A carried location takes the coordinates along, as on the row.
 */
export const carriedChangesOf = (
  series: { readonly carried_text: string | null; readonly changes: string | null },
  copy: Readonly<Record<string, unknown>>,
): EventChanges | undefined => {
  const carried = parseJson(series.carried_text);
  const changes = eventChangesFrom(series.changes);
  const overrides: ReadonlyArray<unknown> =
    isRecord(carried) && Array.isArray(carried['overrides']) ? carried['overrides'] : [];
  const entry = overrides.find(
    (one): one is Record<string, unknown> => isRecord(one) && one['eventId'] === copy['id'],
  );
  if (!changes || !entry || (entry['etag'] ?? null) !== (copy['etag'] ?? null)) {
    return undefined;
  }
  const set: Record<string, unknown> = {};
  const cleared: Array<string> = [];
  for (const field of CARRIED_FIELDS) {
    if (!(field in entry)) {
      continue;
    }
    if (field in changes.set) {
      set[field] = changes.set[field];
    } else if (changes.cleared.includes(field)) {
      cleared.push(field);
    }
  }
  if ('location' in set || cleared.includes('location')) {
    cleared.push('geo');
  }
  return Object.keys(set).length + cleared.length > 0 ? { answers: {}, cleared, set } : undefined;
};

/** The fields a change names as its own (the guest list and answers aside). */
export const namesOf = (changes: EventChanges | undefined): ReadonlyArray<string> =>
  changes
    ? [...Object.keys(changes.set), ...changes.cleared].filter((key) => key !== 'attendees')
    : [];

/** The op kinds whose version of the event is Google's copy with their changes over it. */
export const CHANGING_KINDS: ReadonlySet<string> = new Set(['rsvp', 'update']);

/**
 * The user's version of the event a queued op holds. For an update or an
 * answer of an event Google has a copy of, that copy with the op's changes
 * over it; for the rest (a create, a delete's tombstone, an occurrence
 * Google has no exception for yet) the version it was queued with.
 */
const payloadOf = (row: PendingOpRow, base: unknown): EventRecord | undefined => {
  const stored = parseJson(row.payload);
  const copy = base;
  const changes = parseJson(row.changes);
  // A cancelled copy is a tombstone: Google has the event no more, and
  // there is nothing left of it to lay the changes over.
  if (
    CHANGING_KINDS.has(row.kind) &&
    isRecord(copy) &&
    copy['status'] !== 'cancelled' &&
    isEventChanges(changes)
  ) {
    const shown = decodeOr(
      EventRecord,
      withEventChanges(copy, changes, isRecord(stored) ? stored : undefined),
    );
    if (shown) {
      return shown;
    }
  }
  return decodeOr(EventRecord, stored);
};

/** The exceptions a series delete took: Google's copies of them, none for any other op. */
const takenOf = (row: PendingOpRow): ReadonlyArray<EventRecord> | undefined => {
  const taken = decodeOr(eventListSchema, parseJson(row.taken_payload ?? null));
  return taken && taken.length > 0 ? taken : undefined;
};

/**
 * The series and slot of a queued change of an occurrence Google has no
 * exception for: it has no copy, and is laid over its series drawn at that
 * slot instead (`projectInstance`). Undefined for every other op.
 */
export const slotOf = (
  row: PendingOpRow,
): { readonly masterId: string; readonly originalStartUtc: number } | undefined => {
  if (!CHANGING_KINDS.has(row.kind) || (row.copy_payload ?? null) !== null) {
    return undefined;
  }
  const stored = parseJson(row.payload);
  const masterId = isRecord(stored) ? stored['recurringEventId'] : undefined;
  const originalStartUtc = isRecord(stored) ? stored['originalStartUtc'] : undefined;
  return typeof masterId === 'string' && typeof originalStartUtc === 'number'
    ? { masterId, originalStartUtc }
    : undefined;
};

/** What Google has of a queued change's event, encoded: its copy, else its series at the slot. */
export const baseOf = (row: PendingOpRow, master: EventRecord | undefined): unknown => {
  const copy = parseJson(row.copy_payload ?? null);
  if (copy !== undefined && copy !== null) {
    return copy;
  }
  const slot = slotOf(row);
  return slot && master
    ? Schema.encodeSync(EventRecord)(projectInstance(master, slot.originalStartUtc, 0))
    : undefined;
};

/**
 * What a queued change is laid over, encoded: what Google has of its event
 * (`baseOf`) with the changes queued ahead of it over that. A cancelled
 * copy is a tombstone, and stays one.
 */
export const priorOf = (
  row: PendingOpRow,
  master: EventRecord | undefined,
  earlier: ReadonlyArray<EventChanges>,
): unknown => {
  const base = baseOf(row, master);
  return isRecord(base) && base['status'] !== 'cancelled' && earlier.length > 0
    ? laidOver(base, earlier)
    : base;
};

const changedOf = (row: PendingOpRow): ReadonlyArray<string> | undefined => {
  const changes = eventChangesFrom(row.changes);
  const names = row.kind === 'rsvp' ? Object.keys(changes?.answers ?? {}) : namesOf(changes);
  return names.length > 0 ? names : undefined;
};

/**
 * Undefined for a row with an unknown op kind (nothing could apply it);
 * an unreadable payload degrades to `payload: undefined`, which applyOp
 * reports as a dropped change rather than crashing the queue. `master` is
 * the row of the series an occurrence without a copy belongs to (`slotOf`),
 * `earlier` the changes queued for the event ahead of this op.
 */
export const pendingOpFromRow = (
  row: PendingOpRow,
  master?: EventRecord,
  earlier: ReadonlyArray<EventChanges> = [],
): PendingOp | undefined =>
  OP_KINDS.has(row.kind)
    ? new PendingOp({
        accountId: row.account_id,
        attempts: row.attempts,
        attendeesChanged: row.attendees_changed === 1 ? true : undefined,
        baseEtag: row.base_etag ?? undefined,
        basePayload: CHANGING_KINDS.has(row.kind)
          ? decodeOr(EventRecord, priorOf(row, master, earlier))
          : undefined,
        beforeColorHex: row.before_color_hex ?? undefined,
        beforeOverrides: takenOf(row),
        beforePayload: beforePayloadOf(row),
        calendarId: row.calendar_id,
        carriedText: decodeOr(CarriedText, parseJson(row.carried_text)),
        changed: CHANGING_KINDS.has(row.kind) ? changedOf(row) : undefined,
        colorHex: row.color_hex ?? undefined,
        conflictAt: row.conflict_at ?? undefined,
        copySource: decodeOr(CopySource, parseJson(row.copy_source)),
        createdAt: row.created_at,
        discarded: row.discarded === 1 ? true : undefined,
        dispatchedAt: row.dispatched_at ?? undefined,
        dropsFrom: row.drops_from ?? undefined,
        eventId: row.event_id,
        geoCleared: row.geo_cleared === 1 ? true : undefined,
        id: row.id,
        kind: row.kind as PendingOp['kind'],
        lastError: row.last_error ?? undefined,
        nextAttemptAt: row.next_attempt_at,
        payload: payloadOf(row, priorOf(row, master, earlier)),
        recurrenceCleared: row.recurrence_cleared === 1 ? true : undefined,
        remindersChanged: row.reminders_changed === 1 ? true : undefined,
        sourceGone: row.source_gone === 1 ? true : undefined,
        splitAt: row.split_at ?? undefined,
        splitCheck: row.split_check === 1 ? true : undefined,
        splitIn: row.split_in ?? undefined,
        splitOf: row.split_of ?? undefined,
        targetCalendarId: row.target_calendar_id ?? undefined,
        targetTaskListId: row.target_task_list_id ?? undefined,
        taskDue: row.task_due_cleared === 1 ? null : (row.task_due ?? undefined),
        taskListId: row.task_list_id ?? undefined,
        taskNotes: row.task_notes ?? undefined,
        taskParent: row.task_parent ?? undefined,
        taskPrevious: row.task_previous ?? undefined,
        taskStatus: TASK_STATUSES.has(row.task_status ?? '')
          ? (row.task_status as PendingOp['taskStatus'])
          : undefined,
        taskTitle: row.task_title ?? undefined,
      })
    : undefined;

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
