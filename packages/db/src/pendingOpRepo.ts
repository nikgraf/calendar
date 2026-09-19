import { type PendingOp } from '@calendar/core';
import { Context, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { OPS_KEY } from './keys.ts';
import { pendingOpFromRow, type PendingOpRow } from './rows.ts';
import { eventPayloadJson } from './repoShared.ts';

export interface PendingOpRepoShape {
  /**
   * Kinds of the ops queued before `op` for the same series — the event
   * itself or, for a recurring one, its Google instance ids
   * (`<masterId>_<basetime>`) — in any of the account's calendars. Moves
   * use it to keep order: backoff lets `listDue` skip an older op, and a
   * move must never overtake, or be overtaken by, an edit of that series.
   */
  readonly earlierInSeries: (
    op: PendingOp,
  ) => Effect.Effect<ReadonlyArray<PendingOp['kind']>, SqlError>;
  readonly enqueue: (op: PendingOp) => Effect.Effect<void, SqlError>;
  readonly getById: (opId: string) => Effect.Effect<PendingOp | undefined, SqlError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<PendingOp>, SqlError>;
  readonly listDue: (now: number) => Effect.Effect<ReadonlyArray<PendingOp>, SqlError>;
  /** Persists the pre-network stamp for non-idempotent calls. */
  readonly markDispatched: (opId: string, at: number) => Effect.Effect<void, SqlError>;
  readonly markFailed: (
    opId: string,
    attempts: number,
    nextAttemptAt: number,
    lastError: string,
  ) => Effect.Effect<void, SqlError>;
  readonly remove: (opId: string) => Effect.Effect<void, SqlError>;
  readonly removeForEvent: (calendarId: string, eventId: string) => Effect.Effect<void, SqlError>;
  /** Re-keys queued ops after a server-assigned id replaces a temp id. */
  readonly rewriteEventId: (
    accountId: string,
    calendarId: string,
    oldEventId: string,
    newEventId: string,
  ) => Effect.Effect<void, SqlError>;
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

    return {
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
                                   attendees_changed, geo_cleared, target_calendar_id)
          VALUES (${op.id}, ${op.accountId}, ${op.calendarId}, ${op.kind},
                  ${op.eventId},
                  ${op.payload ? JSON.stringify(eventPayloadJson(op.payload)) : null},
                  ${op.baseEtag ?? null}, ${op.attempts}, ${op.nextAttemptAt},
                  ${op.lastError ?? null}, ${op.createdAt}, ${op.colorHex ?? null},
                  ${op.taskListId ?? null}, ${op.taskStatus ?? null},
                  ${op.taskTitle ?? null}, ${op.taskNotes ?? null}, ${op.taskDue ?? null},
                  ${op.dispatchedAt ?? null}, ${op.attendeesChanged ? 1 : 0},
                  ${op.geoCleared ? 1 : 0}, ${op.targetCalendarId ?? null})
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
      listDue: (now) =>
        Effect.map(
          // rowid breaks created_at ties in insertion order (two ops of one
          // mutation, or a fixed test clock) — order matters for moves.
          sql<PendingOpRow>`SELECT * FROM pending_ops
            WHERE next_attempt_at <= ${now} ORDER BY created_at, rowid LIMIT ${DRAIN_PAGE_SIZE}`,
          (rows) => rows.flatMap(decodedOps),
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
      removeForEvent: (calendarId, eventId) =>
        invalidating(
          Effect.asVoid(
            sql`DELETE FROM pending_ops WHERE calendar_id = ${calendarId}
              AND event_id = ${eventId} AND kind NOT IN ('rsvp', 'move')`,
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
    };
  });

export class PendingOpRepo extends Context.Service<PendingOpRepo, PendingOpRepoShape>()(
  'db/PendingOpRepo',
) {
  static readonly layer: Layer.Layer<PendingOpRepo, never, Reactivity | SqlClient> =
    Layer.effect(PendingOpRepo)(makePendingOpRepo);
}
