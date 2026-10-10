import { type EventRecord, type PendingOp, type TaskRecord } from '@calendar/core';
import { Context, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/reactivity/Reactivity';
import { SqlClient } from 'effect/sql/SqlClient';
import type { SqlError } from 'effect/sql/SqlError';
import { OPS_KEY } from './keys.ts';
import { pendingOpFromRow, type PendingOpRow } from './rows.ts';
import { carriedTextJson, eventListJson, eventPayloadJson, taskPayloadJson } from './repoShared.ts';

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
  /** The task counterpart of `advanceBefore`, for the ops of one task of one list. */
  readonly advanceBeforeTask: (
    task: { readonly accountId: string; readonly listId: string; readonly taskId: string },
    synced: TaskRecord,
    landed: { readonly id: string },
  ) => Effect.Effect<void, SqlError>;
  /**
   * Kinds of the ops queued before `op` for the same series — the event
   * itself or, for a recurring one, its Google instance ids
   * (`<masterId>_<basetime>`) — in any of the account's calendars. Moves
   * use it to keep order: backoff lets `listDue` skip an older op, and a
   * move must never overtake, or be overtaken by, an edit of that series.
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
  ) => Effect.Effect<ReadonlyArray<PendingOp['kind']>, SqlError>;
  readonly enqueue: (op: PendingOp) => Effect.Effect<void, SqlError>;
  /**
   * A pull confirmed these items deleted upstream (`containerId`: the
   * calendar or task list): a queued delete of one has nothing left to put
   * back, so its snapshot goes — a discard would otherwise restore an
   * event or task the sync token has already seen removed.
   */
  readonly forgetDeleted: (
    accountId: string,
    containerId: string,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<void, SqlError>;
  readonly getById: (opId: string) => Effect.Effect<PendingOp | undefined, SqlError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<PendingOp>, SqlError>;
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
  /**
   * Parks an op after a 412: the drain skips it until `unpark` or removal.
   * `serverPayload` is Google's version (undefined = deleted on Google).
   */
  readonly markConflict: (
    opId: string,
    at: number,
    serverPayload: PendingOp['serverPayload'],
  ) => Effect.Effect<void, SqlError>;
  /** Persists the pre-network stamp for non-idempotent calls. */
  readonly markDispatched: (opId: string, at: number) => Effect.Effect<void, SqlError>;
  readonly markFailed: (
    opId: string,
    attempts: number,
    nextAttemptAt: number,
    lastError: string,
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
   * Makes waiting ops due now (one account's, or all): a reconnect or the
   * app coming back is a reason to try again, not to sit out a backoff of
   * up to 30 minutes. Attempts are kept, so the next failure backs off as
   * before. Parked ops wait for the user.
   */
  readonly retryNow: (accountId?: string) => Effect.Effect<void, SqlError>;
  /** Re-keys queued ops after a server-assigned id replaces a temp id. */
  readonly rewriteEventId: (
    accountId: string,
    calendarId: string,
    oldEventId: string,
    newEventId: string,
  ) => Effect.Effect<void, SqlError>;
  /**
   * Replaces one op's event snapshot: a discarded op of the same event
   * takes its change out of the snapshots the others hold.
   */
  readonly setBefore: (opId: string, before: EventRecord) => Effect.Effect<void, SqlError>;
  /**
   * Replaces what one op sends: a discarded op of the same event takes
   * its change out of what the others would send too (an RSVP rides in a
   * guest-list edit's attendees, a guest-list edit in an RSVP's).
   */
  readonly setPayload: (opId: string, payload: EventRecord) => Effect.Effect<void, SqlError>;
  /**
   * Keep-mine: clears the park and the If-Match etag so the next drain
   * overwrites the server copy, and makes the op due immediately.
   */
  readonly unpark: (opId: string, now: number) => Effect.Effect<void, SqlError>;
}

/** Ops one drain pass takes on; a larger backlog continues on the next kick. */
const DRAIN_PAGE_SIZE = 200;

/**
 * `before_payload` keeps its three states apart: absent → SQL NULL, "no
 * row before" → the JSON text `null`, a record → its JSON (rows.ts reads
 * them back the same way).
 */
const beforePayloadColumn = (before: PendingOp['beforePayload']): string | null =>
  before === undefined ? null : before === null ? 'null' : JSON.stringify(eventPayloadJson(before));

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

    return {
      countFor: (accountId, sources) => {
        const { calendarIds, taskListIds } = sources;
        if (calendarIds.length === 0 && taskListIds.length === 0) {
          return Effect.succeed(0);
        }
        const inCalendars =
          calendarIds.length === 0 ? sql`0` : sql`calendar_id IN ${sql.in(calendarIds)}`;
        const inLists =
          taskListIds.length === 0 ? sql`0` : sql`task_list_id IN ${sql.in(taskListIds)}`;
        return Effect.map(
          sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM pending_ops
            WHERE account_id = ${accountId} AND (${inCalendars} OR ${inLists})`,
          (rows) => rows[0]?.count ?? 0,
        );
      },
      earlierInSeries: (op) =>
        Effect.map(
          sql<{ readonly kind: PendingOp['kind'] }>`SELECT kind FROM pending_ops
            WHERE account_id = ${op.accountId} AND id != ${op.id}
              AND (event_id = ${op.eventId}
                OR substr(event_id, 1, length(${op.eventId}) + 1) = ${op.eventId} || '_'
                OR substr(${op.eventId}, 1, length(event_id) + 1) = event_id || '_')
              AND (created_at < ${op.createdAt} OR (created_at = ${op.createdAt}
                AND rowid < (SELECT rowid FROM pending_ops WHERE id = ${op.id})))
            ORDER BY created_at, rowid`,
          (rows) => rows.map((row) => row.kind),
        ),
      enqueue: (op) =>
        invalidating(
          Effect.asVoid(sql`
          INSERT INTO pending_ops (id, account_id, calendar_id, kind, event_id,
                                   payload, base_etag, attempts, next_attempt_at,
                                   last_error, created_at, color_hex,
                                   task_list_id, task_status,
                                   task_title, task_notes, task_due, dispatched_at,
                                   attendees_changed, geo_cleared, target_calendar_id,
                                   reminders_changed, conflict_at, server_payload,
                                   carried_text, recurrence_cleared, before_payload,
                                   before_overrides, before_task, before_color_hex)
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
                  ${op.serverPayload ? JSON.stringify(eventPayloadJson(op.serverPayload)) : null},
                  ${op.carriedText ? JSON.stringify(carriedTextJson(op.carriedText)) : null},
                  ${op.recurrenceCleared ? 1 : 0},
                  ${beforePayloadColumn(op.beforePayload)},
                  ${op.beforeOverrides ? JSON.stringify(eventListJson(op.beforeOverrides)) : null},
                  ${op.beforeTask ? JSON.stringify(taskPayloadJson(op.beforeTask)) : null},
                  ${op.beforeColorHex ?? null})
        `),
        ),
      getById: (opId) =>
        Effect.map(sql<PendingOpRow>`SELECT * FROM pending_ops WHERE id = ${opId}`, (rows) =>
          rows[0] ? pendingOpFromRow(rows[0]) : undefined,
        ),
      listAll: () =>
        Effect.map(
          sql<PendingOpRow>`SELECT * FROM pending_ops ORDER BY created_at, rowid`,
          (rows) => rows.flatMap(decodedOps),
        ),
      // Bounded: one drain handles a page; the next kick takes the rest.
      advanceBaseEtag: ({ accountId, calendarId, eventId }, from, to, landed) =>
        invalidating(
          Effect.asVoid(
            // Queue order is (created_at, rowid), as listDue drains it. A
            // landed op a later edit superseded while it was in flight is
            // no longer queued: everything at its instant came after it.
            sql`UPDATE pending_ops SET base_etag = ${to}
              WHERE account_id = ${accountId} AND calendar_id = ${calendarId}
                AND event_id = ${eventId} AND base_etag = ${from}
                AND conflict_at IS NULL
                AND (created_at > ${landed.createdAt}
                  OR (created_at = ${landed.createdAt}
                    AND rowid > COALESCE(
                      (SELECT rowid FROM pending_ops WHERE id = ${landed.id}), -1)))`,
          ),
        ),
      advanceBefore: ({ accountId, calendarId, eventId }, synced, landed) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET before_payload = ${JSON.stringify(eventPayloadJson(synced))}
              WHERE account_id = ${accountId} AND calendar_id = ${calendarId}
                AND event_id = ${eventId} AND conflict_at IS NULL
                AND kind IN ('delete', 'rsvp', 'update') AND id != ${landed.id}`,
          ),
        ),
      advanceBeforeTask: ({ accountId, listId, taskId }, synced, landed) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET before_task = ${JSON.stringify(taskPayloadJson(synced))}
              WHERE account_id = ${accountId} AND calendar_id = ${listId}
                AND event_id = ${taskId} AND conflict_at IS NULL
                AND kind IN ('completeTask', 'deleteTask', 'updateTask') AND id != ${landed.id}`,
          ),
        ),
      forgetDeleted: (accountId, containerId, ids) =>
        ids.length === 0
          ? Effect.void
          : invalidating(
              Effect.asVoid(
                sql`UPDATE pending_ops SET before_payload = NULL, before_overrides = NULL,
                  before_task = NULL
                  WHERE account_id = ${accountId} AND calendar_id = ${containerId}
                    AND event_id IN ${sql.in(ids)} AND kind IN ('delete', 'deleteTask')`,
              ),
            ),
      listDue: (now) =>
        Effect.map(
          // rowid breaks created_at ties in insertion order (two ops of one
          // mutation, or a fixed test clock) — order matters for moves.
          sql<PendingOpRow>`SELECT * FROM pending_ops
            WHERE next_attempt_at <= ${now} AND conflict_at IS NULL ORDER BY created_at, rowid LIMIT ${DRAIN_PAGE_SIZE}`,
          (rows) => rows.flatMap(decodedOps),
        ),
      listForEvent: ({ accountId, calendarId, eventId }) =>
        Effect.map(
          sql<PendingOpRow>`SELECT * FROM pending_ops
            WHERE account_id = ${accountId} AND calendar_id = ${calendarId}
              AND event_id = ${eventId}
            ORDER BY created_at, rowid`,
          (rows) => rows.flatMap(decodedOps),
        ),
      markConflict: (opId, at, serverPayload) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET conflict_at = ${at},
              server_payload = ${serverPayload ? JSON.stringify(eventPayloadJson(serverPayload)) : null},
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
      remove: (opId) =>
        invalidating(Effect.asVoid(sql`DELETE FROM pending_ops WHERE id = ${opId}`)),
      // RSVP ops survive content-edit coalescing; stray ones resolve as
      // no-ops through the NotFound path after a delete. A queued move is
      // never coalesced away either: a later edit targets the destination
      // calendar and must land after the move, not replace it.
      removeForEvent: (accountId, calendarId, eventId) =>
        invalidating(
          Effect.asVoid(
            sql`DELETE FROM pending_ops WHERE account_id = ${accountId}
              AND calendar_id = ${calendarId} AND event_id = ${eventId}
              AND kind NOT IN ('rsvp', 'move')`,
          ),
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
          Effect.asVoid(
            sql`UPDATE pending_ops SET event_id = ${newEventId}
              WHERE account_id = ${accountId} AND calendar_id = ${calendarId}
                AND event_id = ${oldEventId}`,
          ),
        ),
      setBefore: (opId, before) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET before_payload = ${JSON.stringify(eventPayloadJson(before))}
              WHERE id = ${opId}`,
          ),
        ),
      setPayload: (opId, payload) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET payload = ${JSON.stringify(eventPayloadJson(payload))}
              WHERE id = ${opId}`,
          ),
        ),
      unpark: (opId, now) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET conflict_at = NULL, server_payload = NULL,
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
