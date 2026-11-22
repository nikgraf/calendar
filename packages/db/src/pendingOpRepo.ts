import { type CopySource, type EventRecord, type PendingOp } from '@calendar/core';
import { Context, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/reactivity/Reactivity';
import { SqlClient } from 'effect/sql/SqlClient';
import type { SqlError } from 'effect/sql/SqlError';
import { OPS_KEY } from './keys.ts';
import {
  answerChangesOf,
  carriedChangesOf,
  CHANGING_KINDS,
  eventChangesFrom,
  eventChangesOf,
  eventFromRow,
  type EventRow,
  slotOf,
  HOLDING_KINDS,
  namesOf,
  parseJson,
  pendingOpFromRow,
  type PendingOpRow,
  priorOf,
} from './rows.ts';
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
   * Google's copy of the event becomes `synced`: what Google acknowledged
   * when an op (`landed`) landed while others of the event were queued, or
   * what a pull's page brought. Every queued op of the event reads it, so
   * a discard of one never undoes a landed change along with its own.
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
  /**
   * Queues the op, at the end. `replaces` names a queued op it takes the
   * place of instead: that one leaves, and this one stands where it stood
   * in the queue order (its `createdAt` too), ahead of what was queued
   * behind it.
   */
  readonly enqueue: (op: PendingOp, replaces?: string) => Effect.Effect<void, SqlError>;
  /**
   * A pull confirmed these events deleted upstream: Google's copies of
   * them go, and those of the exceptions a queued delete of one holds, so
   * nothing is left to put back — a discard would otherwise restore an
   * event the sync token has already seen removed. (A task's copy:
   * `TaskRepo.removeCopies`.)
   */
  readonly forgetDeleted: (
    accountId: string,
    calendarId: string,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<void, SqlError>;
  /**
   * A series' delete landed (or found it gone): Google deleted its
   * occurrences with it, so a queued edit, answer or delete of one has no
   * row left to put back. Their copies go (`null`: a discard removes
   * what the op shows) instead of writing an exception back without its
   * master. An occurrence id is `<masterId>_` and a digit; a
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
   * not the whole queue's payloads. `without` is an op on its way out of
   * the queue: left out, and its changes out of the others' versions.
   */
  readonly listForEvent: (
    event: {
      readonly accountId: string;
      readonly calendarId: string;
      readonly eventId: string;
    },
    without?: string,
  ) => Effect.Effect<ReadonlyArray<PendingOp>, SqlError>;
  /**
   * A task's queued ops in every list of the account, in queue order: a
   * move re-queues what follows it in its destination.
   */
  readonly listForTask: (
    accountId: string,
    taskId: string,
  ) => Effect.Effect<ReadonlyArray<PendingOp>, SqlError>;
  /** Makes a waiting op due now (what it waited for left the queue); a parked one stays. */
  readonly makeDue: (opId: string) => Effect.Effect<void, SqlError>;
  /**
   * Parks an op whose event changed on Google: the drain skips it until
   * `unpark` or removal. Google's version is the event's copy by then
   * (`beforePayload`; none means Google deleted the event).
   */
  readonly markConflict: (opId: string, at: number) => Effect.Effect<void, SqlError>;
  /**
   * The user gave the change up, and Google has still to say what it has
   * of the item (`PendingOp.discarded`): it stays queued, due now, never
   * sent again, and says why.
   */
  readonly markDiscarded: (opId: string, reason: string) => Effect.Effect<void, SqlError>;
  /** Persists the pre-network stamp for non-idempotent calls. */
  readonly markDispatched: (opId: string, at: number) => Effect.Effect<void, SqlError>;
  readonly markFailed: (
    opId: string,
    attempts: number,
    nextAttemptAt: number,
    lastError: string,
  ) => Effect.Effect<void, SqlError>;
  /**
   * A pull found the events these moves take out of a calendar gone from
   * it: they have nothing to put back there (`PendingOp.sourceGone`).
   */
  readonly markSourceGone: (opIds: ReadonlyArray<string>) => Effect.Effect<void, SqlError>;
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
   * Writes an op re-keyed to another calendar (its calendar, Google's
   * copy of its event and its retry state) in place: a released move's followers
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
   * their If-Match now. `null`: they send none (the version came from the
   * calendar a queued move takes the event out of, and the move gives it
   * another etag).
   */
  readonly setBaseEtag: (
    event: { readonly accountId: string; readonly calendarId: string; readonly eventId: string },
    etag: string | null,
  ) => Effect.Effect<void, SqlError>;
  /**
   * Replaces Google's copy of the op's event, which every queued op of
   * that event reads as what it replaces (`beforePayload`). `null`: Google
   * has none (a landed change of the series' rule dropped the exception),
   * so there is nothing to put back.
   */
  readonly setBefore: (opId: string, before: EventRecord | null) => Effect.Effect<void, SqlError>;
  /**
   * Replaces the exceptions a change of a series holds (`undefined`:
   * none), each kept as Google's copy of that exception: a delete's while
   * the master is gone locally, and the ones an update drops (a cut, a new
   * rule, new times) until it lands or is given up. A copy an op of the
   * exception itself holds stays whatever is passed.
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
  /**
   * An op of this event (or of its series, or of one of its occurrences)
   * left the queue: the ones that stood back for it are due now, instead
   * of waiting out the backoff they collected standing back. How many.
   */
  readonly wakeWaiting: (event: {
    readonly accountId: string;
    readonly eventId: string;
  }) => Effect.Effect<number, SqlError>;
}

/** The op kinds that can take a series' exceptions off the table (`beforeOverrides`). */
const TAKING_KINDS: ReadonlySet<string> = new Set(['delete', 'update']);

/** Ops one drain pass takes on; a larger backlog continues on the next kick. */
const DRAIN_PAGE_SIZE = 200;

const makePendingOpRepo: Effect.Effect<PendingOpRepoShape, never, Reactivity | SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const reactivity = yield* Reactivity;
    const invalidating = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      reactivity.mutation([OPS_KEY], effect);

    /**
     * Every op with Google's copy of its event joined in: what an event op
     * replaces (`beforePayload`) is kept once per event in `event_copies`,
     * so every queued op of an event reads the same one. And the exceptions
     * a change of a series took off the table (`beforeOverrides`): a
     * delete's are the copies of its exceptions that no delete of their own
     * holds; an update that drops exceptions (`drops_from`) holds the ones
     * that have no row either (an answer may still wait on one).
     */
    const selectOps = sql`SELECT p.*, c.payload AS copy_payload,
        CASE WHEN p.kind = 'delete' THEN (
          SELECT json_group_array(json(x.payload)) FROM event_copies x
          WHERE x.account_id = p.account_id AND x.calendar_id = p.calendar_id
            AND json_extract(x.payload, '$.recurringEventId') = p.event_id
            AND NOT EXISTS (SELECT 1 FROM pending_ops d
              WHERE d.account_id = x.account_id AND d.calendar_id = x.calendar_id
                AND d.event_id = x.id AND d.kind = 'delete')
        ) WHEN p.kind = 'update' AND p.drops_from IS NOT NULL THEN (
          SELECT json_group_array(json(x.payload)) FROM event_copies x
          WHERE x.account_id = p.account_id AND x.calendar_id = p.calendar_id
            AND json_extract(x.payload, '$.recurringEventId') = p.event_id
            AND NOT EXISTS (SELECT 1 FROM pending_ops d
              WHERE d.account_id = x.account_id AND d.calendar_id = x.calendar_id
                AND d.event_id = x.id AND d.kind = 'delete')
            AND NOT EXISTS (SELECT 1 FROM events e
              WHERE e.account_id = x.account_id AND e.calendar_id = x.calendar_id
                AND e.id = x.id)
        ) END AS taken_payload
      FROM pending_ops p
      LEFT JOIN event_copies c ON c.account_id = p.account_id
        AND c.calendar_id = p.calendar_id AND c.id = p.event_id`;
    /**
     * The row of the series a queued change of an occurrence without a
     * copy belongs to (`slotOf`): what that change is laid over.
     */
    const masterOf = (row: PendingOpRow) =>
      Effect.gen(function* () {
        const slot = slotOf(row);
        if (!slot) {
          return undefined;
        }
        const masters = yield* sql<EventRow>`SELECT * FROM events
          WHERE account_id = ${row.account_id} AND calendar_id = ${row.calendar_id}
            AND id = ${slot.masterId}`;
        return masters[0] ? eventFromRow(masters[0]) : undefined;
      });
    /**
     * The changes of every queued update and answer by event, in queue
     * order: an op's version of its event is Google's copy with the ones up
     * to its own laid over it.
     */
    const chains = Effect.map(
      sql<{
        readonly account_id: string;
        readonly calendar_id: string;
        readonly carried_text: string | null;
        readonly changes: string | null;
        readonly event_id: string;
        readonly id: string;
      }>`SELECT id, account_id, calendar_id, event_id, changes, carried_text FROM pending_ops
        WHERE kind IN ('rsvp', 'update') ORDER BY created_at, rowid`,
      (rows) => {
        const byEvent = new Map<string, Array<(typeof rows)[number] & { readonly at: number }>>();
        for (const [at, row] of rows.entries()) {
          const key = JSON.stringify([row.account_id, row.calendar_id, row.event_id]);
          byEvent.set(key, [...(byEvent.get(key) ?? []), { ...row, at }]);
        }
        return byEvent;
      },
    );
    type Chains = Effect.Success<typeof chains>;
    /**
     * The changes queued ahead of the row that its own are laid over, in
     * queue order: the ones of its event, and for an exception the text
     * the queued edits of its series carried onto it (`carriedChangesOf`).
     * `without` is an op on its way out.
     */
    const earlierOf = (all: Chains, row: PendingOpRow, without?: string) => {
      const chainOf = (eventId: unknown) =>
        typeof eventId === 'string'
          ? (all.get(JSON.stringify([row.account_id, row.calendar_id, eventId])) ?? [])
          : [];
      const own = chainOf(row.event_id).find((entry) => entry.id === row.id);
      if (!own) {
        return [];
      }
      const copy = parseJson(row.copy_payload ?? null);
      const exception =
        typeof copy === 'object' && copy !== null ? (copy as Record<string, unknown>) : undefined;
      return [
        ...chainOf(row.event_id).map((entry) => ({
          at: entry.at,
          changes: eventChangesFrom(entry.changes),
          id: entry.id,
        })),
        ...chainOf(exception?.['recurringEventId']).map((entry) => ({
          at: entry.at,
          changes: exception ? carriedChangesOf(entry, exception) : undefined,
          id: entry.id,
        })),
      ]
        .filter((entry) => entry.at < own.at && entry.id !== without)
        .toSorted((left, right) => left.at - right.at)
        .flatMap((entry) => (entry.changes ? [entry.changes] : []));
    };
    const noChains: Chains = new Map();
    /** Rows of an unknown op kind are skipped: nothing could apply them. */
    const decoded = (rows: ReadonlyArray<PendingOpRow>, without?: string) =>
      Effect.gen(function* () {
        const all = rows.some((row) => CHANGING_KINDS.has(row.kind)) ? yield* chains : noChains;
        const ops = yield* Effect.forEach(rows, (row) =>
          Effect.map(masterOf(row), (master) =>
            pendingOpFromRow(row, master, earlierOf(all, row, without)),
          ),
        );
        return ops.flatMap((op) => (op ? [op] : []));
      });
    const putCopy = (accountId: string, calendarId: string, eventId: string, copy: EventRecord) =>
      sql`INSERT OR REPLACE INTO event_copies (account_id, calendar_id, id, payload)
        VALUES (${accountId}, ${calendarId}, ${eventId},
                ${JSON.stringify(eventPayloadJson(copy))})`;
    const dropCopy = (accountId: string, calendarId: string, eventId: string) =>
      sql`DELETE FROM event_copies WHERE account_id = ${accountId}
        AND calendar_id = ${calendarId} AND id = ${eventId}`;
    /**
     * The copies a newly queued op holds. What it replaces is Google's copy
     * of its event, held once: an op queued while another already holds the
     * event reads the copy that one took, whatever the row shows since. The
     * exceptions a series delete took are Google's copies too.
     */
    const holdCopies = (op: PendingOp) =>
      Effect.gen(function* () {
        if (op.beforePayload && HOLDING_KINDS.has(op.kind)) {
          yield* sql`INSERT OR IGNORE INTO event_copies (account_id, calendar_id, id, payload)
            VALUES (${op.accountId}, ${op.calendarId}, ${op.eventId},
                    ${JSON.stringify(eventPayloadJson(op.beforePayload))})`;
        }
        for (const taken of TAKING_KINDS.has(op.kind) ? (op.beforeOverrides ?? []) : []) {
          yield* putCopy(op.accountId, op.calendarId, taken.id, taken);
        }
      });
    /**
     * The place in the queue of the op another takes over (`enqueue`): its
     * order and its `created_at`. That op leaves; none when it left already.
     */
    const takePlace = (replaces: string | undefined) =>
      Effect.gen(function* () {
        if (replaces === undefined) {
          return undefined;
        }
        const [place] = yield* sql<{
          readonly created_at: number;
          readonly place: number;
        }>`SELECT rowid AS place, created_at FROM pending_ops WHERE id = ${replaces}`;
        if (place) {
          yield* sql`DELETE FROM pending_ops WHERE id = ${replaces}`;
        }
        return place;
      });
    /**
     * A copy is kept only while something holds its event: an op that
     * names it, or the queued change of its series that took the exception
     * off the table — its delete, or an update that drops exceptions, while
     * no row shows the exception. The rest go.
     */
    const dropIdleCopies = sql`DELETE FROM event_copies WHERE NOT EXISTS (
      SELECT 1 FROM pending_ops p WHERE p.account_id = event_copies.account_id
        AND p.calendar_id = event_copies.calendar_id
        AND (p.event_id = event_copies.id
          OR (p.event_id = json_extract(event_copies.payload, '$.recurringEventId')
            AND (p.kind = 'delete'
              OR (p.kind = 'update' AND p.drops_from IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM events e
                  WHERE e.account_id = event_copies.account_id
                    AND e.calendar_id = event_copies.calendar_id
                    AND e.id = event_copies.id))))))`;
    /**
     * Writes what an update or an answer changes (`EventChanges`): the
     * fields in which its version differs from what it is laid over as the
     * two stand now — Google's copy with the changes queued ahead of it —
     * and the ones it named before or takes over from the update it
     * replaces (`inherited`), whatever their value. From then on its
     * version is those over that, whatever the copy becomes. One of an
     * event Google has no copy of keeps its version.
     */
    const writeChanges = (opId: string, inherited: ReadonlyArray<string> = []) =>
      Effect.gen(function* () {
        const rows = yield* sql<PendingOpRow>`SELECT p.*, c.payload AS copy_payload
          FROM pending_ops p LEFT JOIN event_copies c ON c.account_id = p.account_id
            AND c.calendar_id = p.calendar_id AND c.id = p.event_id
          WHERE p.id = ${opId}`;
        const row = rows[0];
        if (!row || !CHANGING_KINDS.has(row.kind)) {
          return;
        }
        const copy = priorOf(row, yield* masterOf(row), earlierOf(yield* chains, row));
        const payload = parseJson(row.payload);
        const changes =
          typeof copy === 'object' &&
          copy !== null &&
          typeof payload === 'object' &&
          payload !== null
            ? row.kind === 'rsvp'
              ? answerChangesOf(
                  copy as Record<string, unknown>,
                  payload as Record<string, unknown>,
                  [...Object.keys(eventChangesFrom(row.changes)?.answers ?? {}), ...inherited],
                )
              : eventChangesOf(
                  copy as Record<string, unknown>,
                  payload as Record<string, unknown>,
                  row.attendees_changed === 1,
                  [...namesOf(eventChangesFrom(row.changes)), ...inherited],
                )
            : null;
        yield* sql`UPDATE pending_ops SET changes = ${changes ? JSON.stringify(changes) : null}
          WHERE id = ${opId}`;
      });
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
      enqueue: (op, replaces) =>
        invalidating(
          Effect.gen(function* () {
            const place = yield* takePlace(replaces);
            yield* sql`
          INSERT INTO pending_ops (rowid, id, account_id, calendar_id, kind, event_id,
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
                                   split_at, split_check, copy_source, source_gone,
                                   discarded)
          VALUES (${place?.place ?? null}, ${op.id}, ${op.accountId}, ${op.calendarId}, ${op.kind},
                  ${op.eventId},
                  ${op.payload ? JSON.stringify(eventPayloadJson(op.payload)) : null},
                  ${op.baseEtag ?? null}, ${op.attempts}, ${op.nextAttemptAt},
                  ${op.lastError ?? null}, ${place?.created_at ?? op.createdAt},
                  ${op.colorHex ?? null},
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
                  ${op.copySource ? JSON.stringify(copySourceJson(op.copySource)) : null},
                  ${op.sourceGone ? 1 : 0}, ${op.discarded ? 1 : 0})
        `;
            yield* holdCopies(op);
            yield* writeChanges(op.id, op.changed ?? []);
          }),
        ),
      getById: (opId) =>
        Effect.map(
          Effect.flatMap(sql<PendingOpRow>`${selectOps} WHERE p.id = ${opId}`, decoded),
          (ops) => ops[0],
        ),
      listAll: () =>
        Effect.flatMap(sql<PendingOpRow>`${selectOps} ORDER BY p.created_at, p.rowid`, decoded),
      listDeletes: (accountId, calendarId) =>
        Effect.flatMap(
          sql<PendingOpRow>`${selectOps}
            WHERE p.account_id = ${accountId} AND p.calendar_id = ${calendarId}
              AND p.kind = 'delete'
            ORDER BY p.created_at, p.rowid`,
          decoded,
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
        Effect.flatMap(
          // rowid breaks created_at ties in insertion order (two ops of one
          // mutation, or a fixed test clock) — order matters for moves.
          sql<PendingOpRow>`${selectOps}
            WHERE p.next_attempt_at <= ${now} AND p.conflict_at IS NULL
            ORDER BY p.created_at, p.rowid LIMIT ${DRAIN_PAGE_SIZE}`,
          decoded,
        ),
      listForEvent: ({ accountId, calendarId, eventId }, without) =>
        Effect.flatMap(
          sql<PendingOpRow>`${selectOps}
            WHERE p.account_id = ${accountId} AND p.calendar_id = ${calendarId}
              AND p.event_id = ${eventId} AND p.id IS NOT ${without ?? null}
            ORDER BY p.created_at, p.rowid`,
          (rows) => decoded(rows, without),
        ),
      listForTask: (accountId, taskId) =>
        Effect.flatMap(
          sql<PendingOpRow>`${selectOps}
            WHERE p.account_id = ${accountId} AND p.event_id = ${taskId}
              AND p.kind IN ('completeTask', 'createTask', 'deleteTask', 'moveTask',
                'reorderTask', 'updateTask')
            ORDER BY p.created_at, p.rowid`,
          decoded,
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
      markDiscarded: (opId, reason) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET discarded = 1, next_attempt_at = 0, last_error = ${reason}
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
      markSourceGone: (opIds) =>
        opIds.length === 0
          ? Effect.void
          : invalidating(
              Effect.asVoid(
                sql`UPDATE pending_ops SET source_gone = 1
                  WHERE kind = 'move' AND id IN ${sql.in(opIds)}`,
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
      wakeWaiting: ({ accountId, eventId }) =>
        invalidating(
          Effect.gen(function* () {
            const waiting = yield* sql<{ readonly id: string }>`SELECT id FROM pending_ops
              WHERE account_id = ${accountId} AND conflict_at IS NULL AND next_attempt_at > 0
                AND last_error LIKE 'waiting for %'
                AND (event_id = ${eventId}
                  OR substr(event_id, 1, length(${eventId}) + 1) = ${eventId} || '_'
                  OR substr(${eventId}, 1, length(event_id) + 1) = event_id || '_')`;
            if (waiting.length > 0) {
              yield* sql`UPDATE pending_ops SET next_attempt_at = 0
                WHERE id IN ${sql.in(waiting.map((row) => row.id))}`;
            }
            return waiting.length;
          }),
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
            for (const taken of TAKING_KINDS.has(op.kind) ? (op.beforeOverrides ?? []) : []) {
              yield* putCopy(op.accountId, op.calendarId, taken.id, taken);
            }
            yield* writeChanges(op.id);
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
          Effect.andThen(
            sql`UPDATE pending_ops SET payload = ${JSON.stringify(eventPayloadJson(payload))}
              WHERE id = ${opId}`,
            writeChanges(opId),
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
