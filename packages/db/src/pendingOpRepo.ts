import { type CopySource, type EventRecord, type PendingOp } from '@calendar/core';
import { Context, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/reactivity/Reactivity';
import { SqlClient } from 'effect/sql/SqlClient';
import type { SqlError } from 'effect/sql/SqlError';
import { OPS_KEY } from './keys.ts';
import { HOLDING_KINDS, pendingOpFromRow, type PendingOpRow } from './rows.ts';
import { carriedTextJson, copySourceJson, eventPayloadJson } from './repoShared.ts';

export interface PendingOpRepoShape {
  /**
   * After an op (`landed`) landed: the queued edits and deletes of the same
   * event that were built on the etag it was sent with (`from`) now send
   * the etag it produced (`to`). Google's copy moved on through our own
   * write, and the stale If-Match would 412 against the user's own edit.
   * Only ops queued after it move — they were built on the local row with
   * its change in. One queued before it (in backoff while it overtook) was
   * not: a guest-list edit there still carries the response an RSVP just
   * replaced, and must meet its 412. Parked ops are left alone.
   */
  readonly advanceBaseEtag: (
    event: { readonly accountId: string; readonly calendarId: string; readonly eventId: string },
    from: string,
    to: string,
    landed: { readonly createdAt: number; readonly id: string },
    /** Only content edits: an update that sends no guest list. */
    options?: { readonly editsOnly?: boolean },
  ) => Effect.Effect<void, SqlError>;
  /**
   * After an op (`landed`) landed while others of the event were queued:
   * what Google acknowledged (`synced`) is now what every one of them
   * replaces — the ones queued after it took their snapshot with its
   * change in, the ones before it never held that change — so their
   * snapshots move to it; a discard must not undo the landed change along
   * with its own. Parked ops are left alone.
   */
  readonly advanceBefore: (
    event: { readonly accountId: string; readonly calendarId: string; readonly eventId: string },
    synced: EventRecord,
    landed: { readonly id: string },
  ) => Effect.Effect<void, SqlError>;
  /**
   * The ops queued before `op` for the same series — the event itself or,
   * for a recurring one, its Google instance ids (`<masterId>_<basetime>`)
   * — in any of the account's calendars: their kind, event and
   * `dropsFrom`. Moves use it to keep order: backoff lets `listDue` skip an
   * older op, and a move must never overtake, or be overtaken by, an edit
   * of that series; an occurrence's op waits for a change of the series'
   * rule ahead of it.
   */
  /**
   * How many ops wait for the given calendars and task lists of an account.
   * A calendar mirror stands back while its sources hold unsynced edits:
   * this device would mirror its own version and another the server's.
   */
  readonly countFor: (
    accountId: string,
    sources: {
      readonly calendarIds: ReadonlyArray<string>;
      readonly taskListIds: ReadonlyArray<string>;
    },
  ) => Effect.Effect<number, SqlError>;
  readonly earlierInSeries: (
    op: PendingOp,
  ) => Effect.Effect<
    ReadonlyArray<Pick<PendingOp, 'dropsFrom' | 'eventId' | 'id' | 'kind'>>,
    SqlError
  >;
  /**
   * The task ops of the op's account queued before it, in queue order: a
   * task move and the task ops around it keep that order even when
   * backoff lets the drain skip an older one.
   */
  readonly earlierTaskOps: (
    op: PendingOp,
  ) => Effect.Effect<
    ReadonlyArray<
      Pick<PendingOp, 'calendarId' | 'eventId' | 'kind' | 'targetTaskListId' | 'taskParent'>
    >,
    SqlError
  >;
  readonly enqueue: (op: PendingOp) => Effect.Effect<void, SqlError>;
  /**
   * A pull confirmed these events deleted upstream: a queued delete of
   * one has nothing left to put back, so its snapshot goes — a discard
   * would otherwise restore an event the sync token has already seen
   * removed. (A task's provider copy goes instead: `TaskRepo.removeCopies`.)
   */
  readonly forgetDeleted: (
    accountId: string,
    calendarId: string,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<void, SqlError>;
  /**
   * A series' delete landed (or found it gone): Google deleted its
   * occurrences with it, so a queued edit, answer or delete of one has no
   * row left to put back. Their snapshots say so (`null`: a discard
   * removes what the op shows) instead of writing an exception back
   * without its master. An occurrence id is `<masterId>_` and a digit; a
   * split made in Google's UI (`<masterId>_R…`) is its own series.
   */
  readonly forgetSeries: (
    accountId: string,
    calendarId: string,
    masterId: string,
  ) => Effect.Effect<void, SqlError>;
  readonly getById: (opId: string) => Effect.Effect<PendingOp | undefined, SqlError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<PendingOp>, SqlError>;
  /**
   * The deletes queued in one calendar of one account: few wait at a
   * time, so a pull page is matched against them rather than asking
   * about each of its events.
   */
  readonly listDeletes: (
    accountId: string,
    calendarId: string,
  ) => Effect.Effect<ReadonlyArray<PendingOp>, SqlError>;
  readonly listDue: (now: number) => Effect.Effect<ReadonlyArray<PendingOp>, SqlError>;
  /**
   * The ops queued for one event of one account, in queue order. Every
   * edit and every ack asks this; filtering in SQL decodes only these ops,
   * not the whole queue's payloads.
   */
  readonly listForEvent: (event: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly eventId: string;
  }) => Effect.Effect<ReadonlyArray<PendingOp>, SqlError>;
  /** Makes a waiting op due now (what it waited for left the queue); a parked one stays. */
  /**
   * A task's queued ops in every list of the account, in queue order: a
   * move re-queues what follows it in its destination.
   */
  readonly listForTask: (
    accountId: string,
    taskId: string,
  ) => Effect.Effect<ReadonlyArray<PendingOp>, SqlError>;
  readonly makeDue: (opId: string) => Effect.Effect<void, SqlError>;
  /**
   * Parks an op whose event changed on Google: the drain skips it until
   * `unpark` or removal. Google's version is the event's copy by then
   * (`beforePayload`; none means Google deleted the event).
   */
  readonly markConflict: (opId: string, at: number) => Effect.Effect<void, SqlError>;
  /** Persists the pre-network stamp for non-idempotent calls. */
  readonly markDispatched: (opId: string, at: number) => Effect.Effect<void, SqlError>;
  readonly markFailed: (
    opId: string,
    attempts: number,
    nextAttemptAt: number,
    lastError: string,
  ) => Effect.Effect<void, SqlError>;
  /**
   * The series `masterId` moved from calendar `from` to `to` (or a move of
   * it went back): the creates split off it follow (`splitIn`).
   */
  readonly moveSplits: (
    accountId: string,
    masterId: string,
    from: string,
    to: string,
  ) => Effect.Effect<void, SqlError>;
  readonly remove: (opId: string) => Effect.Effect<void, SqlError>;
  /**
   * Drops the event's queued ops — one account's: a shared calendar
   * carries the same calendar and event ids under every account that
   * subscribes to it.
   */
  readonly removeForEvent: (
    accountId: string,
    calendarId: string,
    eventId: string,
  ) => Effect.Effect<void, SqlError>;
  /**
   * Writes an op re-keyed to another calendar (its calendar, the event
   * snapshots and its retry state) in place: a released move's followers
   * go back keeping their place in the queue, ties on `created_at`
   * included.
   */
  readonly retarget: (op: PendingOp) => Effect.Effect<void, SqlError>;
  /**
   * Makes waiting ops due now (one account's, or all): a reconnect or the
   * app coming back is a reason to try again, not to sit out a backoff of
   * up to 30 minutes. Attempts are kept, so the next failure backs off as
   * before. Parked ops wait for the user.
   */
  readonly retryNow: (accountId?: string) => Effect.Effect<void, SqlError>;
  /**
   * Re-keys queued ops after a server-assigned id replaces a temp id — and
   * points the creates of subtasks carried along under it at the new id.
   */
  readonly rewriteEventId: (
    accountId: string,
    calendarId: string,
    oldEventId: string,
    newEventId: string,
  ) => Effect.Effect<void, SqlError>;
  /**
   * Google's copy of the event moved to `etag` and the queued ops were
   * laid over it again (heldEvents.ts): the ones not parked send it as
   * their If-Match now.
   */
  readonly setBaseEtag: (
    event: { readonly accountId: string; readonly calendarId: string; readonly eventId: string },
    etag: string,
  ) => Effect.Effect<void, SqlError>;
  /**
   * Replaces Google's copy of the op's event, which every queued op of
   * that event reads as what it replaces (`beforePayload`). `null`: Google
   * has none (a landed change of the series' rule dropped the exception),
   * so there is nothing to put back.
   */
  readonly setBefore: (opId: string, before: EventRecord | null) => Effect.Effect<void, SqlError>;
  /**
   * Replaces the exceptions a series delete holds (`undefined`: none),
   * each kept as Google's copy of that exception: they go into it while
   * the master is gone locally. A copy an op of the exception itself
   * holds stays whatever is passed.
   */
  readonly setBeforeOverrides: (
    opId: string,
    overrides: ReadonlyArray<EventRecord> | undefined,
  ) => Effect.Effect<void, SqlError>;
  /**
   * Names what the copies a move or a conversion queued were copied from
   * (`undefined`: nothing — an Apple source the move could not delete
   * stays where it is, and must not be made again).
   */
  readonly setCopySource: (
    opIds: ReadonlyArray<string>,
    source: CopySource | undefined,
  ) => Effect.Effect<void, SqlError>;
  /**
   * Replaces where a series update's drop of exceptions starts
   * (`undefined`: it drops none): one that replaced an update in flight
   * inherited its drop, and drops nothing more once that update landed.
   */
  readonly setDropsFrom: (
    opId: string,
    dropsFrom: number | undefined,
  ) => Effect.Effect<void, SqlError>;
  /**
   * Replaces what one op sends: a discarded op of the same event takes
   * its change out of what the others would send too (an RSVP rides in a
   * guest-list edit's attendees, a guest-list edit in an RSVP's).
   */
  readonly setPayload: (opId: string, payload: EventRecord) => Effect.Effect<void, SqlError>;
  /** Whether a split-off series' create asks Google before it goes (`splitCheck`). */
  readonly setSplitCheck: (opId: string, check: boolean) => Effect.Effect<void, SqlError>;
  /**
   * Keep-mine: clears the park and the If-Match etag so the next drain
   * overwrites the server copy, and makes the op due immediately.
   */
  readonly unpark: (opId: string, now: number) => Effect.Effect<void, SqlError>;
}

/** Ops one drain pass takes on; a larger backlog continues on the next kick. */
const DRAIN_PAGE_SIZE = 200;

/** Rows of an unknown op kind are skipped: nothing could apply them. */
const decodedOps = (row: PendingOpRow): Array<PendingOp> => {
  const op = pendingOpFromRow(row);
  return op ? [op] : [];
};

const makePendingOpRepo: Effect.Effect<PendingOpRepoShape, never, Reactivity | SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const reactivity = yield* Reactivity;
    const invalidating = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      reactivity.mutation([OPS_KEY], effect);

    /**
     * Every op with Google's copy of its event joined in: what an event op
     * replaces (`beforePayload`) is kept once per event in `event_copies`,
     * so every queued op of an event reads the same one.
     */
    const selectOps = sql`SELECT p.*, c.payload AS copy_payload,
        CASE WHEN p.kind = 'delete' THEN (
          SELECT json_group_array(json(x.payload)) FROM event_copies x
          WHERE x.account_id = p.account_id AND x.calendar_id = p.calendar_id
            AND json_extract(x.payload, '$.recurringEventId') = p.event_id
            AND NOT EXISTS (SELECT 1 FROM pending_ops d
              WHERE d.account_id = x.account_id AND d.calendar_id = x.calendar_id
                AND d.event_id = x.id AND d.kind = 'delete')
        ) END AS taken_payload
      FROM pending_ops p
      LEFT JOIN event_copies c ON c.account_id = p.account_id
        AND c.calendar_id = p.calendar_id AND c.id = p.event_id`;
    const putCopy = (accountId: string, calendarId: string, eventId: string, copy: EventRecord) =>
      sql`INSERT OR REPLACE INTO event_copies (account_id, calendar_id, id, payload)
        VALUES (${accountId}, ${calendarId}, ${eventId},
                ${JSON.stringify(eventPayloadJson(copy))})`;
    const dropCopy = (accountId: string, calendarId: string, eventId: string) =>
      sql`DELETE FROM event_copies WHERE account_id = ${accountId}
        AND calendar_id = ${calendarId} AND id = ${eventId}`;
    /**
     * A copy is kept only while something holds its event: an op that
     * names it, or the queued delete of its series, which took its
     * exceptions off the table. The rest go.
     */
    const dropIdleCopies = sql`DELETE FROM event_copies WHERE NOT EXISTS (
      SELECT 1 FROM pending_ops p WHERE p.account_id = event_copies.account_id
        AND p.calendar_id = event_copies.calendar_id
        AND (p.event_id = event_copies.id
          OR (p.kind = 'delete'
            AND p.event_id = json_extract(event_copies.payload, '$.recurringEventId'))))`;
    /** The copies of a series' exceptions that no op of their own holds. */
    const dropTaken = (accountId: string, calendarId: string, masterId: string) =>
      sql`DELETE FROM event_copies WHERE account_id = ${accountId}
        AND calendar_id = ${calendarId}
        AND json_extract(payload, '$.recurringEventId') = ${masterId}
        AND NOT EXISTS (SELECT 1 FROM pending_ops p
          WHERE p.account_id = event_copies.account_id
            AND p.calendar_id = event_copies.calendar_id AND p.event_id = event_copies.id)`;

    return {
      countFor: (accountId, sources) => {
        const { calendarIds, taskListIds } = sources;
        if (calendarIds.length === 0 && taskListIds.length === 0) {
          return Effect.succeed(0);
        }
        const inCalendars =
          calendarIds.length === 0 ? sql`0` : sql`calendar_id IN ${sql.in(calendarIds)}`;
        // A task move counts for the list it goes into too.
        const inLists =
          taskListIds.length === 0
            ? sql`0`
            : sql`(task_list_id IN ${sql.in(taskListIds)}
                OR target_task_list_id IN ${sql.in(taskListIds)})`;
        return Effect.map(
          sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM pending_ops
            WHERE account_id = ${accountId} AND (${inCalendars} OR ${inLists})`,
          (rows) => rows[0]?.count ?? 0,
        );
      },
      earlierInSeries: (op) =>
        Effect.map(
          sql<{
            readonly drops_from: number | null;
            readonly event_id: string;
            readonly id: string;
            readonly kind: PendingOp['kind'];
          }>`SELECT id, kind, event_id, drops_from FROM pending_ops
            WHERE account_id = ${op.accountId} AND id != ${op.id}
              AND (event_id = ${op.eventId}
                OR substr(event_id, 1, length(${op.eventId}) + 1) = ${op.eventId} || '_'
                OR substr(${op.eventId}, 1, length(event_id) + 1) = event_id || '_')
              AND (created_at < ${op.createdAt} OR (created_at = ${op.createdAt}
                AND rowid < (SELECT rowid FROM pending_ops WHERE id = ${op.id})))
            ORDER BY created_at, rowid`,
          (rows) =>
            rows.map((row) => ({
              eventId: row.event_id,
              id: row.id,
              kind: row.kind,
              ...(row.drops_from === null ? {} : { dropsFrom: row.drops_from }),
            })),
        ),
      earlierTaskOps: (op) =>
        Effect.map(
          sql<{
            readonly calendar_id: string;
            readonly event_id: string;
            readonly kind: PendingOp['kind'];
            readonly target_task_list_id: string | null;
            readonly task_parent: string | null;
          }>`SELECT kind, calendar_id, event_id, target_task_list_id, task_parent FROM pending_ops
            WHERE account_id = ${op.accountId} AND id != ${op.id}
              AND kind IN ('completeTask', 'createTask', 'deleteTask', 'moveTask', 'reorderTask',
                'updateTask')
              AND (created_at < ${op.createdAt} OR (created_at = ${op.createdAt}
                AND rowid < (SELECT rowid FROM pending_ops WHERE id = ${op.id})))
            ORDER BY created_at, rowid`,
          (rows) =>
            rows.map((row) => ({
              calendarId: row.calendar_id,
              eventId: row.event_id,
              kind: row.kind,
              ...(row.target_task_list_id === null
                ? {}
                : { targetTaskListId: row.target_task_list_id }),
              ...(row.task_parent === null ? {} : { taskParent: row.task_parent }),
            })),
        ),
      enqueue: (op) =>
        invalidating(
          Effect.gen(function* () {
            yield* sql`
          INSERT INTO pending_ops (id, account_id, calendar_id, kind, event_id,
                                   payload, base_etag, attempts, next_attempt_at,
                                   last_error, created_at, color_hex,
                                   task_list_id, task_status,
                                   task_title, task_notes, task_due, dispatched_at,
                                   attendees_changed, geo_cleared, target_calendar_id,
                                   reminders_changed, conflict_at,
                                   carried_text, recurrence_cleared,
                                   before_color_hex,
                                   target_task_list_id, task_parent, task_due_cleared,
                                   task_previous, drops_from, split_of, split_in,
                                   split_at, split_check, copy_source)
          VALUES (${op.id}, ${op.accountId}, ${op.calendarId}, ${op.kind},
                  ${op.eventId},
                  ${op.payload ? JSON.stringify(eventPayloadJson(op.payload)) : null},
                  ${op.baseEtag ?? null}, ${op.attempts}, ${op.nextAttemptAt},
                  ${op.lastError ?? null}, ${op.createdAt}, ${op.colorHex ?? null},
                  ${op.taskListId ?? null}, ${op.taskStatus ?? null},
                  ${op.taskTitle ?? null}, ${op.taskNotes ?? null}, ${op.taskDue ?? null},
                  ${op.dispatchedAt ?? null}, ${op.attendeesChanged ? 1 : 0},
                  ${op.geoCleared ? 1 : 0}, ${op.targetCalendarId ?? null},
                  ${op.remindersChanged ? 1 : 0}, ${op.conflictAt ?? null},
                  ${op.carriedText ? JSON.stringify(carriedTextJson(op.carriedText)) : null},
                  ${op.recurrenceCleared ? 1 : 0},
                  ${op.beforeColorHex ?? null}, ${op.targetTaskListId ?? null},
                  ${op.taskParent ?? null}, ${op.taskDue === null ? 1 : 0},
                  ${op.taskPrevious ?? null}, ${op.dropsFrom ?? null},
                  ${op.splitOf ?? null}, ${op.splitIn ?? null}, ${op.splitAt ?? null},
                  ${op.splitCheck ? 1 : 0},
                  ${op.copySource ? JSON.stringify(copySourceJson(op.copySource)) : null})
        `;
            // What the op replaces is Google's copy of its event, held once:
            // an op queued while another already holds the event reads the
            // copy that one took, whatever the row shows since.
            if (op.beforePayload && HOLDING_KINDS.has(op.kind)) {
              yield* sql`INSERT OR IGNORE INTO event_copies (account_id, calendar_id, id, payload)
                VALUES (${op.accountId}, ${op.calendarId}, ${op.eventId},
                        ${JSON.stringify(eventPayloadJson(op.beforePayload))})`;
            }
            // The exceptions a series delete took are Google's copies too.
            for (const taken of op.kind === 'delete' ? (op.beforeOverrides ?? []) : []) {
              yield* putCopy(op.accountId, op.calendarId, taken.id, taken);
            }
          }),
        ),
      getById: (opId) =>
        Effect.map(sql<PendingOpRow>`${selectOps} WHERE p.id = ${opId}`, (rows) =>
          rows[0] ? pendingOpFromRow(rows[0]) : undefined,
        ),
      listAll: () =>
        Effect.map(sql<PendingOpRow>`${selectOps} ORDER BY p.created_at, p.rowid`, (rows) =>
          rows.flatMap(decodedOps),
        ),
      listDeletes: (accountId, calendarId) =>
        Effect.map(
          sql<PendingOpRow>`${selectOps}
            WHERE p.account_id = ${accountId} AND p.calendar_id = ${calendarId}
              AND p.kind = 'delete'
            ORDER BY p.created_at, p.rowid`,
          (rows) => rows.flatMap(decodedOps),
        ),
      // Bounded: one drain handles a page; the next kick takes the rest.
      advanceBaseEtag: ({ accountId, calendarId, eventId }, from, to, landed, options) =>
        invalidating(
          Effect.asVoid(
            // Queue order is (created_at, rowid), as listDue drains it. A
            // landed op a later edit superseded while it was in flight is
            // no longer queued: everything at its instant came after it.
            sql`UPDATE pending_ops SET base_etag = ${to}
              WHERE account_id = ${accountId} AND calendar_id = ${calendarId}
                AND event_id = ${eventId} AND base_etag = ${from}
                AND conflict_at IS NULL
                AND (${options?.editsOnly === true ? 1 : 0} = 0
                  OR (kind = 'update' AND attendees_changed = 0))
                AND (created_at > ${landed.createdAt}
                  OR (created_at = ${landed.createdAt}
                    AND rowid > COALESCE(
                      (SELECT rowid FROM pending_ops WHERE id = ${landed.id}), -1)))`,
          ),
        ),
      advanceBefore: ({ accountId, calendarId, eventId }, synced) =>
        invalidating(Effect.asVoid(putCopy(accountId, calendarId, eventId, synced))),
      forgetDeleted: (accountId, calendarId, ids) =>
        ids.length === 0
          ? Effect.void
          : invalidating(
              Effect.asVoid(
                Effect.andThen(
                  sql`DELETE FROM event_copies WHERE account_id = ${accountId}
                    AND calendar_id = ${calendarId} AND id IN ${sql.in(ids)}`,
                  sql`DELETE FROM event_copies WHERE account_id = ${accountId}
                    AND calendar_id = ${calendarId}
                    AND json_extract(payload, '$.recurringEventId') IN ${sql.in(ids)}`,
                ),
              ),
            ),
      forgetSeries: (accountId, calendarId, masterId) =>
        invalidating(
          Effect.asVoid(
            sql`DELETE FROM event_copies
              WHERE account_id = ${accountId} AND calendar_id = ${calendarId}
                AND substr(id, 1, length(${masterId}) + 1) = ${masterId} || '_'
                AND substr(id, length(${masterId}) + 2, 1) GLOB '[0-9]'`,
          ),
        ),
      listDue: (now) =>
        Effect.map(
          // rowid breaks created_at ties in insertion order (two ops of one
          // mutation, or a fixed test clock) — order matters for moves.
          sql<PendingOpRow>`${selectOps}
            WHERE p.next_attempt_at <= ${now} AND p.conflict_at IS NULL
            ORDER BY p.created_at, p.rowid LIMIT ${DRAIN_PAGE_SIZE}`,
          (rows) => rows.flatMap(decodedOps),
        ),
      listForEvent: ({ accountId, calendarId, eventId }) =>
        Effect.map(
          sql<PendingOpRow>`${selectOps}
            WHERE p.account_id = ${accountId} AND p.calendar_id = ${calendarId}
              AND p.event_id = ${eventId}
            ORDER BY p.created_at, p.rowid`,
          (rows) => rows.flatMap(decodedOps),
        ),
      listForTask: (accountId, taskId) =>
        Effect.map(
          sql<PendingOpRow>`${selectOps}
            WHERE p.account_id = ${accountId} AND p.event_id = ${taskId}
              AND p.kind IN ('completeTask', 'createTask', 'deleteTask', 'moveTask',
                'reorderTask', 'updateTask')
            ORDER BY p.created_at, p.rowid`,
          (rows) => rows.flatMap(decodedOps),
        ),
      makeDue: (opId) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET next_attempt_at = 0
              WHERE id = ${opId} AND conflict_at IS NULL`,
          ),
        ),
      markConflict: (opId, at) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET conflict_at = ${at},
              last_error = 'changed on Google'
              WHERE id = ${opId}`,
          ),
        ),
      markDispatched: (opId, at) =>
        invalidating(
          Effect.asVoid(sql`UPDATE pending_ops SET dispatched_at = ${at} WHERE id = ${opId}`),
        ),
      markFailed: (opId, attempts, nextAttemptAt, lastError) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET attempts = ${attempts},
              next_attempt_at = ${nextAttemptAt}, last_error = ${lastError}
              WHERE id = ${opId}`,
          ),
        ),
      moveSplits: (accountId, masterId, from, to) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET split_in = ${to} WHERE account_id = ${accountId}
              AND split_of = ${masterId} AND split_in = ${from}`,
          ),
        ),
      remove: (opId) =>
        invalidating(
          Effect.andThen(sql`DELETE FROM pending_ops WHERE id = ${opId}`, dropIdleCopies),
        ),
      // RSVP ops survive content-edit coalescing; stray ones resolve as
      // no-ops through the NotFound path after a delete. A queued move is
      // never coalesced away either: a later edit targets the destination
      // calendar and must land after the move, not replace it.
      removeForEvent: (accountId, calendarId, eventId) =>
        invalidating(
          Effect.andThen(
            sql`DELETE FROM pending_ops WHERE account_id = ${accountId}
              AND calendar_id = ${calendarId} AND event_id = ${eventId}
              AND kind NOT IN ('rsvp', 'move')`,
            dropIdleCopies,
          ),
        ),
      retarget: (op) =>
        invalidating(
          Effect.gen(function* () {
            yield* sql`UPDATE pending_ops SET calendar_id = ${op.calendarId},
                payload = ${op.payload ? JSON.stringify(eventPayloadJson(op.payload)) : null},
                attempts = ${op.attempts}, next_attempt_at = ${op.nextAttemptAt},
                last_error = ${op.lastError ?? null}
              WHERE id = ${op.id}`;
            // Google's copy follows the op to the calendar it names now.
            if (op.beforePayload && HOLDING_KINDS.has(op.kind)) {
              yield* putCopy(op.accountId, op.calendarId, op.eventId, op.beforePayload);
            }
            for (const taken of op.kind === 'delete' ? (op.beforeOverrides ?? []) : []) {
              yield* putCopy(op.accountId, op.calendarId, taken.id, taken);
            }
            yield* dropIdleCopies;
          }),
        ),
      retryNow: (accountId) =>
        invalidating(
          Effect.asVoid(
            accountId === undefined
              ? sql`UPDATE pending_ops SET next_attempt_at = 0
                  WHERE conflict_at IS NULL AND next_attempt_at > 0`
              : sql`UPDATE pending_ops SET next_attempt_at = 0
                  WHERE account_id = ${accountId} AND conflict_at IS NULL
                    AND next_attempt_at > 0`,
          ),
        ),
      rewriteEventId: (accountId, calendarId, oldEventId, newEventId) =>
        invalidating(
          Effect.gen(function* () {
            yield* sql`UPDATE pending_ops SET event_id = ${newEventId}
              WHERE account_id = ${accountId} AND calendar_id = ${calendarId}
                AND event_id = ${oldEventId}`;
            yield* sql`UPDATE pending_ops SET task_parent = ${newEventId}
              WHERE account_id = ${accountId} AND task_parent = ${oldEventId}`;
          }),
        ),
      setBaseEtag: ({ accountId, calendarId, eventId }, etag) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET base_etag = ${etag}
              WHERE account_id = ${accountId} AND calendar_id = ${calendarId}
                AND event_id = ${eventId} AND conflict_at IS NULL
                AND kind IN ('delete', 'rsvp', 'update')`,
          ),
        ),
      setBefore: (opId, before) =>
        invalidating(
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly account_id: string;
              readonly calendar_id: string;
              readonly event_id: string;
            }>`SELECT account_id, calendar_id, event_id FROM pending_ops WHERE id = ${opId}`;
            const row = rows[0];
            if (row) {
              yield* before
                ? putCopy(row.account_id, row.calendar_id, row.event_id, before)
                : dropCopy(row.account_id, row.calendar_id, row.event_id);
            }
          }),
        ),
      setBeforeOverrides: (opId, overrides) =>
        invalidating(
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly account_id: string;
              readonly calendar_id: string;
              readonly event_id: string;
            }>`SELECT account_id, calendar_id, event_id FROM pending_ops WHERE id = ${opId}`;
            const row = rows[0];
            if (!row) {
              return;
            }
            yield* dropTaken(row.account_id, row.calendar_id, row.event_id);
            for (const taken of overrides ?? []) {
              yield* putCopy(row.account_id, row.calendar_id, taken.id, taken);
            }
          }),
        ),
      setCopySource: (opIds, source) =>
        invalidating(
          Effect.forEach(
            opIds,
            (opId) =>
              sql`UPDATE pending_ops
                SET copy_source = ${source ? JSON.stringify(copySourceJson(source)) : null}
                WHERE id = ${opId}`,
            { discard: true },
          ),
        ),
      setDropsFrom: (opId, dropsFrom) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET drops_from = ${dropsFrom ?? null} WHERE id = ${opId}`,
          ),
        ),
      setPayload: (opId, payload) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET payload = ${JSON.stringify(eventPayloadJson(payload))}
              WHERE id = ${opId}`,
          ),
        ),
      setSplitCheck: (opId, check) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET split_check = ${check ? 1 : 0} WHERE id = ${opId}`,
          ),
        ),
      unpark: (opId, now) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET conflict_at = NULL,
              base_etag = NULL, attempts = 0, next_attempt_at = ${now}, last_error = NULL
              WHERE id = ${opId}`,
          ),
        ),
    };
  });

export class PendingOpRepo extends Context.Service<PendingOpRepo, PendingOpRepoShape>()(
  'db/PendingOpRepo',
) {
  static readonly layer: Layer.Layer<PendingOpRepo, never, Reactivity | SqlClient> =
    Layer.effect(PendingOpRepo)(makePendingOpRepo);
}
