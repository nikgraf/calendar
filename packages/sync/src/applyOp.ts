import {
  Attendee,
  contrastingTextColor,
  type CopySource,
  EventRecord,
  failureText,
  normalizeHexColor,
  PendingOp,
  placedTask,
  provisionalPosition,
  TaskRecord,
  withConsistentGeo,
} from '@calendar/core';
import type {
  AccountRepoShape,
  CalendarRepoShape,
  EventRepoShape,
  PendingOpRepoShape,
  TaskRepoShape,
} from '@calendar/db';
import {
  type GcalEvent,
  type GcalTask,
  type GoogleCalendarClientShape,
  type GoogleRequestError,
  type GoogleTasksClientShape,
  type GuestNotificationMode,
  GuestNotifications,
  mapGcalCalendar,
  mapGcalEvent,
  hasGuests,
  mapGcalTask,
  toGcalAttendees,
  toGcalEventInput,
  toGcalGeoInsert,
  toGcalGeoPatch,
  toGcalRemindersInsert,
  toGcalRemindersPatch,
  toGcalTimesPatch,
} from '@calendar/google';
import { Cause, Clock, Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import { restoreCarriedText } from './carriedText.ts';
import { changedFields, makeHeldEvents, responseOf, withAnswers } from './heldEvents.ts';
import { makeHeldTasks, withTaskChange } from './heldTasks.ts';
import { askSplits, holdsSplit, ofSplitSeries, settleSplit } from './splitSeries.ts';
import {
  drawsSlot,
  dropSeriesExceptions,
  forgetDropped,
  putBack,
  restoreDropped,
  takeIntoDelete,
} from './takenExceptions.ts';
import { makeApplyTaskOrder, readTaskOrder } from './taskOrder.ts';

/**
 * Guests get emailed about any change to an event that has guests — the
 * decision was "always notify, never ask" (the GuestNotifications
 * reference only lets the live test suites mute it). Google ignores the
 * flag when nothing guest-relevant changed; rooms alone are nobody to
 * notify, but a guest-list edit notifies whoever was just removed.
 */
const sendUpdatesFor = (
  payload: EventRecord,
  attendeesChanged: boolean,
  mode: GuestNotificationMode,
): GuestNotificationMode | undefined => (hasGuests(payload) || attendeesChanged ? mode : undefined);

/**
 * The pending-op drain's per-op dispatch: one arm per op kind, mapping every
 * failure to 'done' (drop), 'retry' (backoff) or, for a 412, a parked
 * conflict. Split out of mutations.ts —
 * the queue-correctness rules live in docs/architecture.md.
 */
/** An Apple item a copy toward Google came from (`CopySource`): deleted from EventKit, kept as it was. */
export type AppleCopySource = Exclude<CopySource, { readonly kind: 'held' }>;

export interface ApplyOpDeps {
  readonly accountRepo: AccountRepoShape;
  readonly calendarRepo: CalendarRepoShape;
  readonly client: GoogleCalendarClientShape;
  readonly eventRepo: EventRepoShape;
  /** Broadcasts that a queued change was permanently rejected (DROPPED_NOTICE_KEY). */
  readonly notifyDropped: Effect.Effect<void>;
  readonly pendingOpRepo: PendingOpRepoShape;
  /**
   * Makes an Apple source again, as it was when a move or a conversion
   * copied it toward Google: the copy will not land. Logs what it cannot
   * make; never fails.
   */
  readonly restoreCopySource: (source: AppleCopySource) => Effect.Effect<void>;
  readonly taskRepo: TaskRepoShape;
  readonly tasksClient: GoogleTasksClientShape;
  /**
   * Runs `effect` as one transaction. A mutation's queue changes commit in
   * one too, so a row settled here is either settled before an edit
   * queues, or sees that edit and leaves the row to it.
   */
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError, R>;
}

/**
 * 'done' removes the op; a retry carries the reason the queue shows the
 * user; a conflict parks the op with Google's version (null = deleted on
 * Google) until the user chooses.
 */
export type ApplyOutcome =
  | 'done'
  | { readonly conflict: EventRecord | null }
  | { readonly retry: string };
const retry = (reason: string): ApplyOutcome => ({ retry: reason });

/** Tag + message (or cause) — a tagged error's own string form is just the tag. */
const describeFailure = (value: unknown): string => {
  if (value && typeof value === 'object') {
    const error = value as { _tag?: string; cause?: unknown; message?: string; name?: string };
    const tag = error._tag ?? error.name ?? 'Error';
    const detail = error.message || (error.cause === undefined ? '' : failureText(error.cause));
    return detail ? `${tag}: ${detail}` : tag;
  }
  return String(value);
};

/** How far back a list is asked for a task's deletion (`deletedIn`): thirty days. */
const DELETED_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/** Event ops a queued move of the same series must not be reordered with. */
const EVENT_KINDS: ReadonlySet<PendingOp['kind']> = new Set(['create', 'delete', 'rsvp', 'update']);

const TASK_KINDS: ReadonlySet<PendingOp['kind']> = new Set([
  'completeTask',
  'createTask',
  'deleteTask',
  'moveTask',
  'reorderTask',
  'updateTask',
]);

/**
 * Only these can meet a 412 and park. An RSVP sends If-Match too, but
 * answers its own 412 by sending again without it.
 */
const PARKABLE_KINDS: ReadonlySet<PendingOp['kind']> = new Set(['delete', 'update']);

/**
 * Whether `row` is Google's copy of an event put back on the table while
 * a delete of it still waits (`queued`: the event's ops). A delete takes
 * its row or leaves a pending tombstone, and a pull writes no row for an
 * event whose delete waits, so a synced, live row there is Google's
 * exception put back for that delete to take: by a discard or keep-theirs
 * of the series change that dropped it (`restoreDropped`, `putBack`).
 */
export const isPulledCopy = (
  queued: ReadonlyArray<PendingOp>,
  row: EventRecord | null | undefined,
): boolean =>
  row?.syncStatus === 'synced' &&
  row.status !== 'cancelled' &&
  queued.some((op) => op.kind === 'delete');

/**
 * What an update sends: of the PATCH body its version makes, the keys
 * that differ from the body Google's copy makes. A PATCH leaves what it
 * does not name as it is, so a field the user did not change is never
 * written from this device's copy of it, which may be older than Google's.
 * An occurrence Google has no exception for is measured against its series
 * drawn at the slot: Google fills the rest of the new exception from it.
 * With neither (the series is not on Google yet) the whole body.
 */
const changedBody = (op: PendingOp, record: EventRecord): ReturnType<typeof updateBody> => {
  const body = updateBody(op, record);
  if (!op.basePayload) {
    return body;
  }
  const theirs = updateBody(op, op.basePayload) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(body).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(theirs[key]),
    ),
  ) as ReturnType<typeof updateBody>;
};

/** What an update PATCHes, built the same way from the user's record and from Google's. */
const updateBody = (op: PendingOp, record: EventRecord) => ({
  ...toGcalEventInput(record),
  ...toGcalTimesPatch(record),
  // Location coordinates ride along as values while the record has
  // them, as explicit nulls (deleting the keys) when this edit dropped
  // them, and not at all otherwise.
  ...toGcalGeoPatch(record, op.geoCleared === true),
  // "Does not repeat": an absent key would keep Google's rule, so the
  // patch sends an empty list — unless a later edit gave it a rule again.
  ...(op.recurrenceCleared === true && record.recurrence === undefined ? { recurrence: [] } : {}),
  ...toGcalRemindersPatch(record, op.remindersChanged === true),
  // The guest list rides along only when this edit changed it: Google
  // replaces the whole array, and our copy may lack fields we never
  // model (optional, comment, additionalGuests).
  ...(op.attendeesChanged ? { attendees: toGcalAttendees(record) } : {}),
});

/** The text fields a series edit carries onto its exceptions. */
type CarriedField = 'description' | 'location' | 'title';

/** `revert: false` keeps the row's content and only hands it back to sync. */
export interface ReleaseOptions {
  readonly revert?: boolean;
}

/**
 * What an abandoned edit or RSVP puts back, over the row as it is now.
 * An RSVP owns only the answers it changed (what it sends may carry a
 * rename made between two RSVPs, which still belongs to the queued
 * edit). An edit owns the fields it changed, and the guest list only when
 * it edited it — and even then each guest's answer stays what the row
 * shows, since answers belong to RSVPs.
 */
const ownedFields = (
  op: PendingOp,
  current: EventRecord,
  before: EventRecord,
  payload: EventRecord,
): Partial<EventRecord> => {
  if (op.kind === 'rsvp') {
    const changed = (payload.attendees ?? []).filter((attendee) => {
      const was = responseOf(before.attendees, attendee.email);
      return was !== undefined && was !== attendee.responseStatus;
    });
    if (changed.length === 0 || !current.attendees) {
      return {};
    }
    return {
      attendees: current.attendees.map((attendee) => {
        const was = changed.some((guest) => guest.email === attendee.email)
          ? responseOf(before.attendees, attendee.email)
          : undefined;
        return was === undefined ? attendee : new Attendee({ ...attendee, responseStatus: was });
      }),
    };
  }
  const { attendees: _attendees, ...rest } = changedFields(before, payload);
  if (!op.attendeesChanged) {
    return rest;
  }
  return {
    ...rest,
    attendees: before.attendees?.map((guest) => {
      const now = responseOf(current.attendees, guest.email);
      return now === undefined ? guest : new Attendee({ ...guest, responseStatus: now });
    }),
  };
};

/**
 * An op re-keyed with its event to another calendar of the account (a
 * move queued, or a move Google never made): what a discard puts back,
 * what it sends and a parked op's copy of Google's live there now too. It
 * starts over and is due at once; a parked op stays parked, its reason
 * with it.
 */
export const retargetOp = (op: PendingOp, calendarId: string): PendingOp => {
  const retarget = (record: EventRecord) => new EventRecord({ ...record, calendarId });
  return new PendingOp({
    ...op,
    attempts: 0,
    beforeOverrides: op.beforeOverrides?.map((row) => retarget(row)),
    beforePayload: op.beforePayload ? retarget(op.beforePayload) : op.beforePayload,
    calendarId,
    lastError: op.conflictAt === undefined ? undefined : op.lastError,
    nextAttemptAt: 0,
    payload: op.payload ? retarget(op.payload) : undefined,
  });
};

export interface ApplyOp {
  /**
   * A pull's page brought what this write made while it still waits — the
   * event a create inserted, or the event in the calendar a move takes it
   * to: the write landed and its answer was lost. Settled as that answer
   * would have settled it, the op still queued; whether it was. Run with
   * no request out (under the drain's gate).
   */
  readonly acknowledge: (op: PendingOp, record: EventRecord) => Effect.Effect<boolean>;
  readonly apply: (op: PendingOp) => Effect.Effect<ApplyOutcome>;
  /**
   * After a change of a series was given up: takes along the queued
   * changes of its occurrences at a slot the series does not draw without
   * it (see the implementation).
   */
  readonly dropUndrawn: (op: PendingOp) => Effect.Effect<void, SqlError>;
  /** An account about to go: what its queued copies were copied from stays. */
  readonly releaseAccountCopies: (accountId: string) => Effect.Effect<void, SqlError>;
  /** Puts back what an abandoned op changed locally and hands its row to sync (also used by discard). */
  readonly releaseRow: (op: PendingOp, options?: ReleaseOptions) => Effect.Effect<void>;
  /**
   * A discarded move that was sent (an event's or a task's): Google may
   * have made it, its answer lost. The destination decides whether it
   * lands or goes back: `done` once Google said. Run with no request out
   * (under the drain's gate), the move still queued.
   */
  readonly settleDiscardedMove: (op: PendingOp) => Effect.Effect<ApplyOutcome>;
}

/**
 * Whether an op waits for the create ahead of it to land: it names a
 * temp id (`local-`), its own or its parent task's, which that create
 * swaps for Google's.
 */
const tempIdGate = (op: PendingOp): ApplyOutcome | undefined => {
  // A task op queued behind its create while that create is still in
  // backoff: the create's id swap rewrites this op's eventId once it
  // lands. Patching the temp id now would 404 and the NotFound arm
  // would drop the local row — wait instead.
  if (op.kind !== 'createTask' && op.eventId.startsWith('local-')) {
    return retry('waiting for the create ahead of it to land');
  }
  // A subtask carried along by a move nests under its parent's server
  // id, which the parent's create swaps in once it lands.
  if (op.kind === 'createTask' && op.taskParent?.startsWith('local-') === true) {
    return retry('waiting for its parent task to land');
  }
  return undefined;
};

export const makeApplyOp = (deps: ApplyOpDeps): ApplyOp => {
  const {
    accountRepo,
    calendarRepo,
    client,
    eventRepo,
    notifyDropped,
    pendingOpRepo,
    restoreCopySource,
    taskRepo,
    tasksClient,
    transaction,
  } = deps;
  const taken = { eventRepo, pendingOpRepo };
  const held = makeHeldTasks({ pendingOpRepo, taskRepo });
  const heldEvents = makeHeldEvents({ eventRepo, pendingOpRepo });

  /**
   * Where a put-back row stands with sync: still pending while another op
   * of the item owns it — one in its calendar, or a queued move of the
   * event, which sits in the source calendar and settles the row itself
   * once it lands (or fails and re-keys it back).
   */
  const releasedStatus = (op: PendingOp): Effect.Effect<EventRecord['syncStatus'], SqlError> =>
    Effect.map(
      Effect.all([othersQueued(op), pendingOpRepo.earlierInSeries(op)]),
      ([others, earlier]) =>
        others || earlier.some((entry) => entry.kind === 'move') ? 'pending' : 'synced',
    );

  /** The hand-back of a change that landed after all: the exceptions' own text, then the flag. */
  const handBack = (op: PendingOp) =>
    Effect.andThen(
      Effect.ignore(restoreCarriedText({ eventRepo, pendingOpRepo }, op)),
      eventRepo.markSynced(op.accountId, op.calendarId, op.eventId),
    );

  /**
   * An abandoned update or RSVP: the row goes back to what the edit
   * replaced. The etag stays the row's own — an earlier op of ours that
   * landed moved it (`advanceEtag`), and whatever that op changed on
   * Google comes back with the next incremental pull. A row a pull
   * deleted meanwhile is not resurrected (pulls delete pending rows too).
   */
  const revertEdit = (op: PendingOp) =>
    Effect.gen(function* () {
      if (op.beforePayload === undefined) {
        return yield* handBack(op);
      }
      yield* Effect.ignore(restoreCarriedText({ eventRepo, pendingOpRepo }, op));
      // The other queued ops of the event were made with this change in
      // what they send: it goes out of that (an RSVP rides in a guest-list
      // edit's attendees and the other way round). Google's copy of the
      // event never held it.
      if (op.beforePayload !== null && op.payload) {
        const before = op.basePayload ?? op.beforePayload;
        const payload = op.payload;
        for (const other of yield* pendingOpRepo.listForEvent(op)) {
          if (other.id === op.id || other.conflictAt !== undefined) {
            continue;
          }
          // One laid over Google's copy is that copy with its own changes:
          // this change is out of it once it is out of the queue. But for
          // a guest-list edit made after an answer: its list holds it.
          const derived =
            other.basePayload !== undefined &&
            !(op.kind === 'rsvp' && other.attendeesChanged === true);
          if (other.payload && other.kind !== 'delete' && !derived) {
            yield* pendingOpRepo.setPayload(
              other.id,
              new EventRecord({
                ...other.payload,
                ...ownedFields(op, other.payload, before, payload),
              }),
            );
          }
        }
      }
      const current = yield* eventRepo.getById(op.accountId, op.calendarId, op.eventId);
      if (!current) {
        // A waiting series delete took the exception off the table: what
        // it puts back is Google's copy, which never held this change.
        return;
      }
      if (isPulledCopy(yield* pendingOpRepo.listForEvent(op), current)) {
        // Google's copy never held this change: nothing goes back.
        return;
      }
      if (op.beforePayload === null) {
        // The edit materialized this override from a plain occurrence; it
        // goes unless another op (an RSVP on the occurrence) still owns it
        // — that op's landing settles the row with Google's copy.
        if (!(yield* othersQueued(op))) {
          yield* eventRepo.deleteEvent(op.accountId, op.calendarId, op.eventId);
        }
        return;
      }
      const syncStatus = yield* releasedStatus(op);
      const others = (yield* pendingOpRepo.listForEvent(op)).filter((other) => other.id !== op.id);
      // With nothing else queued for the event the row is Google's copy
      // again, whole: what a pull brought while this op waited included.
      // Otherwise only what this op owns goes back, and the rest of the
      // row is whatever the other ops of the event made it.
      const whole = others.length === 0 || !op.payload;
      // What still waits is laid over Google's copy without this change;
      // where nothing is (a delete, an op that keeps its version whole),
      // this change's own fields go back to what it was laid over.
      const waiting = (yield* pendingOpRepo.listForEvent(op, op.id)).findLast(
        (other) =>
          (other.kind === 'rsvp' || other.kind === 'update') &&
          other.basePayload !== undefined &&
          other.payload !== undefined,
      )?.payload;
      const row = new EventRecord({
        ...(whole
          ? op.beforePayload
          : (waiting ?? {
              ...current,
              ...ownedFields(op, current, op.basePayload ?? op.beforePayload, op.payload),
            })),
        calendarId: op.calendarId,
        etag: op.beforePayload.etag ?? current.etag,
        id: op.eventId,
        syncStatus,
      });
      // An exception keep-mine left for this change while its series delete
      // waits with the master gone: once no op but an answer owns it (an
      // answer survives the delete), it goes into that delete as keep-mine
      // takes such a row (`takeBackPulled`), not back onto the table, where
      // it showed as an event of its own.
      if (others.every((other) => other.kind === 'rsvp') && (yield* takeIntoDelete(taken, row))) {
        yield* eventRepo.deleteEvent(op.accountId, op.calendarId, op.eventId);
      } else {
        yield* eventRepo.upsertMany([row]);
      }
      // A series edit gone: the series is Google's again, and so are the
      // exceptions the edit held off the table (a cut's, a new rule's, new
      // times'): they come back where that series draws them. The series
      // a this-and-following edit split off goes.
      if (op.kind === 'update') {
        yield* restoreDropped(taken, op);
        if (op.dropsFrom !== undefined) {
          yield* askSplits(taken, op);
        }
      }
    });

  /**
   * An abandoned delete: Google's copy of the event comes back as its
   * row, unless a synced row sits there already (a discard or keep-theirs
   * put Google's copy back). An instance delete's tombstone sits over its override under
   * the same id, so a pending row is the delete's own and is replaced; a
   * tombstone over a plain occurrence is simply removed.
   */
  const revertDelete = (op: PendingOp) =>
    Effect.gen(function* () {
      if (op.beforePayload === undefined) {
        return;
      }
      const current = yield* eventRepo.getById(op.accountId, op.calendarId, op.eventId);
      if (op.beforePayload === null) {
        if (current?.syncStatus === 'pending') {
          yield* eventRepo.deleteEvent(op.accountId, op.calendarId, op.eventId);
        }
        return;
      }
      // A synced row here is Google's copy, put back already
      // (`restoreDropped`, keep-theirs) or never taken: it stays.
      if (!current || current.syncStatus === 'pending') {
        const restored = new EventRecord({
          ...op.beforePayload,
          calendarId: op.calendarId,
          id: op.eventId,
          syncStatus: yield* releasedStatus(op),
        });
        // An exception whose series delete waits with the master gone
        // goes into that delete: on the table it showed as an event of its
        // own.
        if (yield* takeIntoDelete(taken, restored)) {
          if (current) {
            yield* eventRepo.deleteEvent(op.accountId, op.calendarId, op.eventId);
          }
        } else {
          yield* eventRepo.upsertMany([restored]);
        }
      }
      // A series delete took the exceptions with it and owns no row at
      // their ids: one there since is newer and stays. The series is back
      // as Google has it, with what a cut or a rule change this delete
      // replaced had dropped, and without the series split off it.
      yield* putBack(taken, op.accountId, op.calendarId, op.beforeOverrides ?? []);
      yield* askSplits(taken, op);
    });

  /**
   * A task write that landed with an answer that did not decode: Google
   * has the change, so its copy takes it (a reorder: the row's place) and
   * the row follows.
   */
  const landedUnseen = (op: PendingOp, listId: string) =>
    transaction(
      Effect.gen(function* () {
        const copy = yield* held.copyOf(op.accountId, op.eventId);
        if (!copy) {
          return yield* taskRepo.markSynced(op.accountId, listId, op.eventId);
        }
        const row =
          op.kind === 'reorderTask'
            ? yield* taskRepo.get(op.accountId, listId, op.eventId)
            : undefined;
        yield* taskRepo.putCopy(row ? placedTask(copy, row) : withTaskChange(copy, op));
        yield* held.refresh(op.accountId, op.eventId, op.id);
      }),
    );

  /** One queued reorder shown on its row: under its parent, after the sibling it names. */
  const showReorder = (reorder: PendingOp, listId: string) =>
    Effect.gen(function* () {
      const siblings = (yield* taskRepo.listSiblings(
        reorder.accountId,
        listId,
        reorder.taskParent,
      )).filter((sibling) => sibling.id !== reorder.eventId);
      yield* taskRepo.updateLocal({
        accountId: reorder.accountId,
        changes: {
          parentId: reorder.taskParent ?? null,
          position: provisionalPosition(siblings, reorder.taskPrevious),
        },
        listId,
        taskId: reorder.eventId,
      });
    });

  /**
   * An abandoned reorder: the task goes back under the parent and to the
   * position Google has it at, and the reorders still queued for it are
   * shown over that in queue order, as Google will apply them.
   */
  const revertTaskReorder = (op: PendingOp, listId: string) =>
    transaction(
      Effect.gen(function* () {
        const copy = yield* held.copyOf(op.accountId, op.eventId);
        const current = yield* taskRepo.get(op.accountId, listId, op.eventId);
        if (!copy || !current) {
          return yield* held.refresh(op.accountId, op.eventId, op.id);
        }
        yield* taskRepo.upsertTasks([placedTask(current, copy)], yield* Clock.currentTimeMillis);
        const rest = (yield* held.holders(op.accountId, op.eventId, op.id)).filter(
          (other) => other.kind === 'reorderTask' && other.calendarId === listId,
        );
        for (const reorder of rest) {
          yield* showReorder(reorder, listId);
        }
        yield* held.refresh(op.accountId, op.eventId, op.id);
        // Where it is now, with the reorders still queued replayed: an
        // earlier one may have put it back under a parent too.
        const parentId = (yield* taskRepo.get(op.accountId, listId, op.eventId))?.parentId;
        if (parentId !== undefined && parentId !== current.parentId) {
          yield* keepParent(op.accountId, listId, parentId);
        }
      }),
    );

  /**
   * A task back under a parent whose delete is queued (its reorder or its
   * move out of the list undone): Google would delete it with the parent,
   * though the user deleted the parent without it. A subtask kept is a
   * parent kept, as when a subtask's delete is discarded.
   */
  const keepParent = (accountId: string, listId: string, parentId: string) =>
    Effect.gen(function* () {
      const parentDelete = (yield* pendingOpRepo.listForEvent({
        accountId,
        calendarId: listId,
        eventId: parentId,
      })).find((other) => other.kind === 'deleteTask');
      if (parentDelete) {
        yield* pendingOpRepo.remove(parentDelete.id);
        yield* releaseRow(parentDelete);
      }
    });

  const applyTaskOrder = makeApplyTaskOrder({ pendingOpRepo, taskRepo });

  /**
   * A reorder landed: Google renumbered the siblings it left and joined
   * without bumping their `updated`, so no pull will bring that. The
   * list's order is read back at once rather than on the next pass, and
   * the reorders still queued are replayed over it. Best effort — the move
   * itself landed either way, and the next pass sees the list's `updated`
   * move and reads the order too.
   */
  const refreshTaskOrder = (landed: PendingOp, listId: string) =>
    Effect.ignore(
      Effect.flatMap(readTaskOrder(tasksClient, landed.accountId, listId), (entries) =>
        transaction(applyTaskOrder(landed.accountId, listId, entries, landed.id)),
      ),
    );

  /**
   * An abandoned color change: the previous color comes back while the
   * calendar still shows this op's. Calendar-list pulls do not skip a
   * calendar with a queued color (there is no pending flag on it), so a
   * color another device chose meanwhile is Google's and stays.
   */
  const revertColor = (op: PendingOp, before: string) =>
    Effect.gen(function* () {
      const calendar = (yield* calendarRepo.list(op.accountId)).find(
        (candidate) => candidate.id === op.calendarId,
      );
      if (
        calendar &&
        op.colorHex !== undefined &&
        normalizeHexColor(calendar.colorHex) === normalizeHexColor(op.colorHex)
      ) {
        yield* calendarRepo.setColor(op.accountId, op.calendarId, before);
      }
    });

  /**
   * A task move that will not happen (discarded, refused, or Google no
   * longer has the task where the move looks for it): the task and the
   * subtasks it took along go back to the source list — the task under
   * its old parent — and are handed back to sync. Moved on or deleted
   * since, the task is owned by those later ops: nothing to put back.
   */
  /**
   * The moves back to the source a released task move drops (see
   * revertTaskMove): Google never moved those tasks, so their rows are
   * Google's there, each under the parent Google has it under (a move had
   * taken it out of it) — unless an op queued since owns one.
   */
  const settleCameBack = (
    op: PendingOp,
    to: string,
    cameBack: ReadonlyMap<string, string | undefined>,
    now: number,
  ) =>
    Effect.gen(function* () {
      if (cameBack.size === 0) {
        return;
      }
      const owners = new Set(
        (yield* pendingOpRepo.listAll())
          .filter(
            (queued) =>
              queued.id !== op.id && queued.accountId === op.accountId && queued.calendarId === to,
          )
          .map((queued) => queued.eventId),
      );
      for (const [id, parentId] of cameBack) {
        const row = yield* taskRepo.get(op.accountId, to, id);
        const subtasks = yield* taskRepo.listSubtasks(op.accountId, to, id);
        if (row) {
          const { parentId: _detached, ...rest } = row;
          yield* taskRepo.upsertTasks(
            [new TaskRecord({ ...rest, ...(parentId === undefined ? {} : { parentId }) })],
            now,
          );
        }
        for (const back of row ? [row, ...subtasks] : subtasks) {
          yield* owners.has(back.id)
            ? taskRepo.markPending(op.accountId, to, back.id)
            : taskRepo.markSynced(op.accountId, to, back.id);
          yield* held.refresh(op.accountId, back.id, op.id);
        }
      }
    });

  /**
   * Puts a task's move back. `keepsParent: false` when Google has the
   * task no more (a 404 nobody asked for, the task deleted elsewhere):
   * back under a parent whose delete waits, it is no reason to keep that
   * parent.
   */
  const revertTaskMove = (op: PendingOp, keepsParent = true) =>
    transaction(
      Effect.gen(function* () {
        const from = op.targetTaskListId;
        const to = op.taskListId;
        if (from === undefined || to === undefined) {
          return;
        }
        const moved = yield* taskRepo.get(op.accountId, from, op.eventId);
        // Its subtasks' rows go back even when the task's own is gone (deleted
        // there since): Google still has them in the source. Moved on, they
        // went along, and none are left here.
        const subtasks = yield* taskRepo.listSubtasks(op.accountId, from, op.eventId);
        const ids = new Set([op.eventId, ...subtasks.map((subtask) => subtask.id)]);
        // What was queued for them behind the move (edits, a further move)
        // goes back with them: Google still has them in the source. A subtask
        // deleted since has no row; its delete names its parent. What was
        // queued before it stays where it is — an earlier move out of the
        // destination (the task was there, left, and came back) re-keyed here
        // became a move into its own source. The task's next move out of the
        // destination ends what goes back, as for an event (releaseMove): it
        // now leaves from the source, or, back to the source, has nothing left
        // to move and goes — re-keyed, it was a move into its own list, whose
        // answer took the task's row away.
        const all = yield* pendingOpRepo.listAll();
        const at = all.findIndex((queued) => queued.id === op.id);
        // The parent Google has each of them under: a subtask deleted since
        // the move has no row, and its delete is found by it.
        const parentOf = new Map(
          (yield* taskRepo.listCopies(op.accountId)).map((copy) => [copy.id, copy.parentId]),
        );
        // Where a task is once this move is undone: what was queued before
        // it for the task still places it.
        const parentWithout = (taskId: string) =>
          Effect.map(held.placeOf(op.accountId, taskId, op.id), (place) => place?.parentId);
        // The subtasks this move carried: under the task, in its source, when
        // the move was queued. One that had left it on its own before is
        // not: Google still has it under the task, but its later moves are
        // its own, and stay.
        const carried = new Set<string>();
        for (const [id, parent] of parentOf) {
          const place =
            parent === op.eventId ? yield* held.placeBefore(op.accountId, id, op.id) : undefined;
          if (place?.parentId === op.eventId && place.listId === to) {
            carried.add(id);
          }
        }
        const owned = new Set<string>();
        // Moved back to the source since (the task, or a subtask on its own),
        // with the parent Google still has it under.
        const cameBack = new Map<string, string | undefined>();
        for (const other of at === -1 ? all : all.slice(at + 1)) {
          if (
            other.id === op.id ||
            other.accountId !== op.accountId ||
            other.calendarId !== from ||
            !(ids.has(other.eventId) || carried.has(other.eventId))
          ) {
            continue;
          }
          const movesOn = other.kind === 'moveTask' && other.eventId === op.eventId;
          if (other.kind === 'moveTask' && other.targetTaskListId === to) {
            yield* pendingOpRepo.remove(other.id);
            cameBack.set(other.eventId, yield* parentWithout(other.eventId));
            if (movesOn) {
              break;
            }
            continue;
          }
          owned.add(other.eventId);
          yield* pendingOpRepo.remove(other.id);
          yield* pendingOpRepo.enqueue(new PendingOp({ ...other, calendarId: to, taskListId: to }));
          if (movesOn) {
            break;
          }
        }
        // Moved on or deleted since: the later ops own the task's row.
        const now = yield* Clock.currentTimeMillis;
        let backUnder: string | undefined;
        for (const row of moved ? [moved, ...subtasks] : subtasks) {
          // Where it is without this move: the source, or wherever a move
          // still queued puts it — back under a parent whose own move waits,
          // Google will take it along, so its row goes where that parent is.
          const place:
            | { readonly listId: string; readonly parentId: string | undefined }
            | undefined = yield* held.placeOf(op.accountId, row.id, op.id);
          const listId: string = place?.listId ?? to;
          const { parentId: current, ...rest } = row;
          const parentId = row.id === op.eventId ? place?.parentId : current;
          if (row.id === op.eventId && listId === to) {
            backUnder = parentId;
          }
          yield* taskRepo.removeTask(op.accountId, from, row.id);
          yield* taskRepo.upsertTasks(
            [
              new TaskRecord({
                ...rest,
                listId,
                ...(parentId === undefined ? {} : { parentId }),
              }),
            ],
            now,
          );
          if (owned.has(row.id) || listId !== to) {
            yield* taskRepo.markPending(op.accountId, listId, row.id);
          }
          // Google's copy with what still waits for it; Google's alone otherwise.
          yield* held.refresh(op.accountId, row.id, op.id);
        }
        if (backUnder !== undefined && keepsParent) {
          yield* keepParent(op.accountId, to, backUnder);
        }
        yield* settleCameBack(op, to, cameBack, now);
      }),
    );

  /**
   * A move whose 404 may only mean an earlier attempt landed and its
   * answer was lost: Google then has the task in the destination already.
   * Found there, the move is settled; otherwise it is put back. A lookup
   * with no answer decides nothing and the move asks again, also one the
   * user discarded (`givenUp`, `PendingOp.discarded`).
   */
  const settleOrRevertTaskMove = (
    op: PendingOp,
    givenUp = op.discarded === true,
  ): Effect.Effect<ApplyOutcome> =>
    Effect.gen(function* () {
      const destination = op.targetTaskListId;
      if (destination !== undefined) {
        // Every page touched since the move was queued; an unanswered
        // lookup decides nothing — the move stays queued and asks again.
        let landed: GcalTask | undefined;
        let deletedThere = false;
        let pageToken: string | undefined;
        do {
          const page = yield* Effect.result(
            tasksClient.listTasks({
              accountId: op.accountId,
              params: {
                pageToken,
                updatedMin: new Date(op.createdAt - 60_000).toISOString(),
              },
              taskListId: destination,
            }),
          );
          if (page._tag === 'Failure') {
            // The destination list itself is gone: the move cannot land.
            if (
              page.failure._tag === 'NotFoundError' ||
              page.failure._tag === 'SyncTokenExpiredError'
            ) {
              break;
            }
            return retry('Google did not say where the task is');
          }
          landed = page.success.items?.find((item) => item.id === op.eventId && !item.deleted);
          deletedThere ||=
            page.success.items?.some((item) => item.id === op.eventId && item.deleted === true) ??
            false;
          pageToken = page.success.nextPageToken;
        } while (landed === undefined && pageToken !== undefined);
        if (landed) {
          yield* Effect.ignore(settleTaskMove(op, destination, landed));
          return 'done' as const;
        }
        if (deletedThere) {
          yield* Effect.ignore(transaction(dropMovedTask(op, destination)));
          return 'done' as const;
        }
      }
      // Nobody asked for this: a 404 that is the task gone from its source
      // too (deleted on another device) puts nothing back under a parent.
      const gone =
        !givenUp && op.taskListId !== undefined ? yield* deletedIn(op, op.taskListId) : false;
      yield* Effect.ignore(revertTaskMove(op, !gone));
      if (gone && op.taskListId !== undefined) {
        // Put back as a row Google has no more: it goes, copy and all.
        const source = op.taskListId;
        yield* Effect.ignore(
          transaction(
            Effect.andThen(
              taskRepo.removeTask(op.accountId, source, op.eventId),
              taskRepo.removeCopies(op.accountId, source, [op.eventId]),
            ),
          ),
        );
      }
      return 'done' as const;
    });

  /**
   * Whether a list names the op's task as deleted; no answer is a no. Asked
   * well back from the op: the task may have been deleted there long
   * before a device that had not heard of it queued the move.
   */
  const deletedIn = (op: PendingOp, taskListId: string) =>
    Effect.gen(function* () {
      let pageToken: string | undefined;
      do {
        const page = yield* Effect.result(
          tasksClient.listTasks({
            accountId: op.accountId,
            params: {
              pageToken,
              updatedMin: new Date(op.createdAt - DELETED_LOOKBACK_MS).toISOString(),
            },
            taskListId,
          }),
        );
        if (page._tag === 'Failure') {
          return false;
        }
        if (page.success.items?.some((item) => item.id === op.eventId && item.deleted === true)) {
          return true;
        }
        pageToken = page.success.nextPageToken;
      } while (pageToken !== undefined);
      return false;
    });

  /**
   * The destination lists the task as deleted: the move landed, its answer
   * lost, and the task was deleted there since, its subtasks with it. Put
   * back in the source, they showed for good — Google sends the source no
   * tombstone for a task that left it. Their rows, Google's copies and
   * what was queued for them behind the move go instead.
   */
  const dropMovedTask = (op: PendingOp, destination: string) =>
    Effect.gen(function* () {
      const carried = (yield* taskRepo.listCopies(op.accountId)).filter(
        (copy) => copy.listId === op.taskListId && copy.parentId === op.eventId,
      );
      const ids = new Set([
        op.eventId,
        ...carried.map((copy) => copy.id),
        ...(yield* taskRepo.listSubtasks(op.accountId, destination, op.eventId)).map(
          (subtask) => subtask.id,
        ),
      ]);
      for (const id of ids) {
        for (const queued of yield* pendingOpRepo.listForTask(op.accountId, id)) {
          if (queued.id === op.id) {
            continue;
          }
          yield* pendingOpRepo.remove(queued.id);
          // A move of its own since took its row on to another list.
          if (queued.kind === 'moveTask' && queued.targetTaskListId !== undefined) {
            yield* taskRepo.removeTask(op.accountId, queued.targetTaskListId, id);
          }
        }
        yield* taskRepo.removeTask(op.accountId, destination, id);
        const copy = yield* held.copyOf(op.accountId, id);
        if (copy) {
          yield* taskRepo.removeCopies(op.accountId, copy.listId, [id]);
        }
      }
    });

  /**
   * A task move landed (`task` is Google's copy in `destination`): the row
   * there settles, its subtasks' rows are handed back to sync, and rows of
   * them still in the source go — Google sends no tombstone for a task
   * that left a list.
   */
  const settleTaskMove = (op: PendingOp, destination: string, task: GcalTask) =>
    transaction(
      Effect.gen(function* () {
        const synced = mapGcalTask(task, { accountId: op.accountId, taskListId: destination });
        const source = op.taskListId;
        // The subtasks Google took along: its copies of them are in the
        // destination now, like the task's own.
        const carried =
          source === undefined
            ? []
            : (yield* taskRepo.listCopies(op.accountId)).filter(
                (copy) => copy.listId === source && copy.parentId === op.eventId,
              );
        // The row there settles, unless the user moved it on (or deleted it)
        // while this op waited: those ops hold it, on Google's copy.
        if (synced) {
          yield* settleTask(op, synced);
        }
        for (const copy of carried) {
          yield* taskRepo.removeCopies(op.accountId, copy.listId, [copy.id]);
          yield* taskRepo.putCopy(new TaskRecord({ ...copy, listId: destination }));
          yield* held.refresh(op.accountId, copy.id, op.id);
        }
        // A subtask's row the move took along with no copy of Google's (it
        // has none there any more, or never had): nothing holds it now, and
        // sync has it again.
        const known = new Set(carried.map((copy) => copy.id));
        for (const subtask of yield* taskRepo.listSubtasks(op.accountId, destination, op.eventId)) {
          if (!known.has(subtask.id)) {
            yield* held.refresh(op.accountId, subtask.id, op.id);
          }
        }
        if (source !== undefined) {
          for (const id of [op.eventId, ...carried.map((copy) => copy.id)]) {
            yield* taskRepo.removeSyncedTask(op.accountId, source, id);
          }
        }
      }),
    );

  /**
   * A parent's delete landed, or found it gone: Google deleted its subtasks
   * with it, so their own deletes — one still waiting on a retry — are
   * settled too, and none is left to discard back into a task Google no
   * longer has.
   */
  const retireSubtaskDeletes = (op: PendingOp) =>
    Effect.gen(function* () {
      const nested = new Map(
        (yield* taskRepo.listCopies(op.accountId))
          .filter((copy) => copy.parentId === op.eventId)
          .map((copy) => [copy.id, copy.listId]),
      );
      for (const queued of yield* pendingOpRepo.listAll()) {
        const listId = nested.get(queued.eventId);
        if (
          queued.kind === 'deleteTask' &&
          queued.accountId === op.accountId &&
          queued.calendarId === op.calendarId &&
          listId !== undefined
        ) {
          yield* pendingOpRepo.remove(queued.id);
          yield* taskRepo.removeCopies(op.accountId, listId, [queued.eventId]);
        }
      }
    });

  /**
   * A task create that will not land takes the ops queued behind it on
   * its temp id: they wait for the id it would have swapped in
   * (`tempIdGate`), which never comes — a delete the user made while it
   * was out among them.
   */
  const retireFollowers = (op: PendingOp, listId: string) =>
    Effect.gen(function* () {
      for (const queued of yield* pendingOpRepo.listForEvent({
        accountId: op.accountId,
        calendarId: listId,
        eventId: op.eventId,
      })) {
        if (queued.id !== op.id) {
          yield* pendingOpRepo.remove(queued.id);
        }
      }
    });

  /**
   * What was queued behind a create Google never got (discarded, or refused
   * for good) goes with it and puts nothing back. The event's edits,
   * answers and delete were built on an event Google may never have had: a
   * delete discarded later restored it as one. So were the changes of a
   * series' occurrences: sent, each met a 404. A move (mutations.ts
   * googleServerMove) already put the rows at its destination, where its
   * 404 would put them back in the source as synced: the move goes, and so
   * do the rows and whatever followed it there — another move included,
   * whose destination is followed in turn, since a chain of moves leaves
   * the rows at its end (left there, pending with no op, nothing ever
   * collected them). One the create landed after all comes back with the
   * next pull, as Google has it.
   */
  const dropCreateFollowers = (op: PendingOp) =>
    Effect.gen(function* () {
      const seen = new Set<string>();
      const calendars = [op.calendarId];
      for (
        let calendarId = calendars.pop();
        calendarId !== undefined;
        calendarId = calendars.pop()
      ) {
        if (seen.has(calendarId)) {
          continue;
        }
        seen.add(calendarId);
        for (const queued of yield* pendingOpRepo.listForEvent({
          accountId: op.accountId,
          calendarId,
          eventId: op.eventId,
        })) {
          if (queued.id === op.id) {
            continue;
          }
          yield* pendingOpRepo.remove(queued.id);
          if (queued.kind === 'move' && queued.targetCalendarId !== undefined) {
            calendars.push(queued.targetCalendarId);
          }
        }
        // A series: the changes queued for its occurrences name ids of
        // their own (`<id>_<start>`), and go with the rows they made.
        for (const queued of yield* pendingOpRepo.listAll()) {
          if (
            queued.accountId === op.accountId &&
            queued.calendarId === calendarId &&
            queued.payload?.recurringEventId === op.eventId
          ) {
            yield* pendingOpRepo.remove(queued.id);
          }
        }
        for (const override of yield* eventRepo.listOverrides(
          op.accountId,
          calendarId,
          op.eventId,
        )) {
          yield* eventRepo.deleteEvent(op.accountId, calendarId, override.id);
        }
        if (calendarId !== op.calendarId) {
          yield* eventRepo.deleteEvent(op.accountId, calendarId, op.eventId);
        }
      }
    });

  /**
   * The local row an abandoned op left `pending` (a discard, a permanent
   * rejection, keep-mine with nothing left to keep): what the op changed
   * is put back from Google's copy of the item, so the screen shows what
   * Google has, and the row is handed back to sync — a pull never writes
   * over a pending row. A dropped create takes its optimistic row with it
   * (deleteStale never collects pending rows, so it would render forever
   * as something Google never had).
   */
  const releaseRow = (op: PendingOp, options: ReleaseOptions = {}): Effect.Effect<void> => {
    const revert = options.revert ?? true;
    switch (op.kind) {
      case 'move':
        // Not reverted (a 2xx that did not decode): Google made the move.
        return op.targetCalendarId
          ? Effect.ignore(
              revert
                ? transaction(releaseMove(op, op.targetCalendarId))
                : landMove(op, op.targetCalendarId, undefined),
            )
          : Effect.void;
      case 'create':
        return Effect.ignore(
          Effect.gen(function* () {
            if (revert) {
              yield* abandonCopy(op);
            }
            yield* eventRepo.deleteEvent(op.accountId, op.calendarId, op.eventId);
            // One that landed (a 2xx that did not decode) keeps what follows it.
            if (revert) {
              yield* dropCreateFollowers(op);
            }
          }),
        );
      case 'createTask': {
        const listId = op.taskListId;
        return listId
          ? Effect.ignore(
              Effect.gen(function* () {
                if (revert) {
                  yield* abandonCopy(op);
                }
                yield* taskRepo.removeTask(op.accountId, listId, op.eventId);
                yield* retireFollowers(op, listId);
                // Subtasks a move carried along under it wait for its server
                // id, which it will never get: they go with it.
                for (const subtask of yield* taskRepo.listSubtasks(
                  op.accountId,
                  listId,
                  op.eventId,
                )) {
                  yield* taskRepo.removeTask(op.accountId, listId, subtask.id);
                  for (const queued of yield* pendingOpRepo.listForEvent({
                    accountId: op.accountId,
                    calendarId: listId,
                    eventId: subtask.id,
                  })) {
                    yield* pendingOpRepo.remove(queued.id);
                  }
                }
              }),
            )
          : Effect.void;
      }
      // An abandoned edit or toggle: the row is rebuilt from Google's copy
      // and what still waits (a completion queued after a discarded rename
      // keeps its tick), and is Google's again once nothing does.
      case 'completeTask':
      case 'updateTask':
        return op.taskListId
          ? Effect.ignore(
              revert
                ? transaction(held.refresh(op.accountId, op.eventId, op.id, true))
                : landedUnseen(op, op.taskListId),
            )
          : Effect.void;
      // An abandoned delete: Google's copy comes back as the row. One that
      // landed leaves nothing to hold.
      case 'deleteTask':
        return op.taskListId
          ? Effect.ignore(
              revert
                ? transaction(held.refresh(op.accountId, op.eventId, op.id, true))
                : forgetCopy(op),
            )
          : Effect.void;
      case 'reorderTask':
        return op.taskListId
          ? Effect.ignore(
              revert ? revertTaskReorder(op, op.taskListId) : landedUnseen(op, op.taskListId),
            )
          : Effect.void;
      case 'moveTask':
        // Google still has the task in the source list.
        return Effect.ignore(revertTaskMove(op));
      // In one transaction: one that failed half way left a series a cut's
      // undo took along half there, its rows pending with no op.
      case 'rsvp':
      case 'update':
        return Effect.ignore(revert ? transaction(revertEdit(op)) : handBack(op));
      case 'delete':
        return revert ? Effect.ignore(transaction(revertDelete(op))) : Effect.void;
      case 'calendarColor':
        return revert && op.beforeColorHex
          ? Effect.ignore(revertColor(op, op.beforeColorHex))
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  /**
   * A copy that will not land (dropped, discarded, its calendar or list
   * gone): what it was copied from stays. A Google source's deletes it
   * held go with it, putting the source back as Google has it; an Apple
   * source is made again. A copy the user deleted before it went left the
   * queue without this: its source goes as moved.
   */
  const releaseCopySource = (op: PendingOp): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const source = op.copySource;
      if (source === undefined) {
        return;
      }
      if (source.kind !== 'held') {
        return yield* restoreCopySource(source);
      }
      for (const opId of source.opIds) {
        const held = yield* pendingOpRepo.getById(opId);
        if (held) {
          yield* pendingOpRepo.remove(opId);
          yield* releaseRow(held);
        }
      }
    });

  /**
   * A create that will not land, whose item the user moved on meanwhile:
   * its sent create stayed, with the move's delete queued behind it, and
   * the next copy holds that delete. That copy takes over what this one
   * was copied from, in place of the delete, which goes — it would delete
   * nothing, and released later it would put back a row Google never had.
   * Whether a copy took it over.
   */
  const handOn = (op: PendingOp): Effect.Effect<boolean, SqlError> =>
    Effect.gen(function* () {
      const behind = new Set(
        (yield* pendingOpRepo.listForEvent({
          accountId: op.accountId,
          calendarId: op.calendarId,
          eventId: op.eventId,
        }))
          .filter((other) => other.kind === 'delete' || other.kind === 'deleteTask')
          .map((other) => other.id),
      );
      const taken = new Set<string>();
      for (const holder of yield* pendingOpRepo.listAll()) {
        const held = holder.copySource;
        if (held?.kind !== 'held' || !held.opIds.some((opId) => behind.has(opId))) {
          continue;
        }
        const rest = held.opIds.filter((opId) => !behind.has(opId));
        yield* pendingOpRepo.setCopySource(
          [holder.id],
          rest.length > 0 ? { kind: 'held', opIds: rest } : op.copySource,
        );
        for (const opId of held.opIds) {
          if (behind.has(opId)) {
            taken.add(opId);
          }
        }
      }
      for (const opId of taken) {
        yield* pendingOpRepo.remove(opId);
      }
      return taken.size > 0;
    });

  /**
   * A copy that will not land: the next copy takes its source over, or the
   * source stays — unless the user deleted the copy (or moved it back to
   * Apple, which deletes it here) while its create was out: then the
   * source goes as they meant, the deletes it held free to go.
   */
  const abandonCopy = (op: PendingOp): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      if (yield* handOn(op)) {
        return;
      }
      const deleted = (yield* pendingOpRepo.listForEvent({
        accountId: op.accountId,
        calendarId: op.calendarId,
        eventId: op.eventId,
      })).some((other) => other.kind === 'delete' || other.kind === 'deleteTask');
      if (!deleted) {
        return yield* releaseCopySource(op);
      }
      if (op.copySource?.kind === 'held') {
        for (const opId of op.copySource.opIds) {
          yield* pendingOpRepo.makeDue(opId);
        }
      }
    });

  /**
   * An account about to go takes its queued ops with it, without the drain:
   * a copy queued there never lands, so what it was copied from stays
   * (or a copy it was moved on to takes it over), as for any copy that
   * will not land.
   */
  const releaseAccountCopies = (accountId: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const copies = (yield* pendingOpRepo.listAll()).filter(
        (op) =>
          op.accountId === accountId &&
          (op.kind === 'create' || op.kind === 'createTask') &&
          op.copySource !== undefined,
      );
      for (const { id } of copies) {
        // Read again: one released before may have handed its source on to it.
        const op = yield* pendingOpRepo.getById(id);
        if (op) {
          yield* pendingOpRepo.remove(id);
          yield* abandonCopy(op);
        }
      }
    });

  /**
   * A move's or a conversion's delete of its source waits while a copy
   * that holds it (`copySource`) is queued: sent first, it left nothing
   * when Google turned the copy down.
   */
  const copyGate = (op: PendingOp): Effect.Effect<ApplyOutcome | undefined, SqlError> =>
    op.kind !== 'delete' && op.kind !== 'deleteTask'
      ? Effect.succeed(undefined)
      : Effect.map(pendingOpRepo.listAll(), (queued) =>
          queued.some(
            (other) => other.copySource?.kind === 'held' && other.copySource.opIds.includes(op.id),
          )
            ? retry('waiting for its copy to land')
            : undefined,
        );

  /** A series' local rows (master + overrides) in one calendar. */
  const seriesRows = (accountId: string, calendarId: string, masterId: string) =>
    Effect.gen(function* () {
      const master = yield* eventRepo.getById(accountId, calendarId, masterId);
      const overrides = yield* eventRepo.listOverrides(accountId, calendarId, masterId);
      return master ? [master, ...overrides] : overrides;
    });

  /**
   * A move Google never made (discarded, refused, or a 404 for the event
   * or the destination): the server still has the event in the source.
   * Its rows go back there, and so does what googleServerMove re-queued
   * behind the move — edits, a this-and-following cut's master update, a
   * move onwards — Google's copies with them: addressed to
   * the destination it would 404 and be dropped, while the source row
   * showed what Google never got. The series' next move out of the
   * destination ends what goes back: it now leaves from the source (one
   * back to the source has nothing left to move), and it took the rows
   * along — any in the destination now, and what is queued there, are a
   * later move's back into it. A row a queued op owns stays as it was
   * (pending, or a pulled copy a delete waits for, synced for
   * dropPulledCopy), and all stay while a move into the source is queued
   * (it settles them); the rest go to sync.
   *
   * Only what was queued after the move goes, so the move is still queued
   * here (a discard releases a move before removing it); one no longer
   * queued was released already.
   * An occurrence's id is the master's, `_` and its original start; a
   * series split off in Google's own UI (`<id>_R<start>`) is its own.
   */
  const releaseMove = (op: PendingOp, destination: string) =>
    Effect.gen(function* () {
      const { accountId, calendarId: source, eventId: masterId } = op;
      const inSeries = (eventId: string) =>
        eventId === masterId ||
        (eventId.startsWith(`${masterId}_`) && /\d/.test(eventId.charAt(masterId.length + 1)));
      const all = yield* pendingOpRepo.listAll();
      const at = all.findIndex((queued) => queued.id === op.id);
      if (at === -1) {
        return;
      }
      let movedOn = false;
      for (const queued of all.slice(at + 1)) {
        if (
          queued.accountId !== accountId ||
          queued.calendarId !== destination ||
          !inSeries(queued.eventId)
        ) {
          continue;
        }
        yield* queued.kind === 'move' && queued.targetCalendarId === source
          ? pendingOpRepo.remove(queued.id)
          : pendingOpRepo.retarget(retargetOp(queued, source));
        if (queued.kind === 'move') {
          movedOn = true;
          break;
        }
      }
      if (!movedOn) {
        for (const row of yield* seriesRows(accountId, destination, masterId)) {
          yield* eventRepo.deleteEvent(accountId, destination, row.id);
          yield* eventRepo.upsertMany([new EventRecord({ ...row, calendarId: source })]);
        }
        // The series split off it point back at it there (splitSeries.ts).
        yield* pendingOpRepo.moveSplits(accountId, masterId, destination, source);
      }
      const others = (yield* pendingOpRepo.listAll()).filter(
        (queued) => queued.id !== op.id && queued.accountId === accountId,
      );
      if (
        others.some(
          (queued) =>
            queued.kind === 'move' &&
            queued.eventId === masterId &&
            queued.targetCalendarId === source,
        )
      ) {
        return;
      }
      const owned = new Set(
        others.filter((queued) => queued.calendarId === source).map((queued) => queued.eventId),
      );
      for (const row of yield* seriesRows(accountId, source, masterId)) {
        if (owned.has(row.id)) {
          continue;
        }
        if (op.sourceGone === true) {
          // A pull found it gone from here while the move waited, and its
          // token has moved past that: back as a synced row, it stayed for
          // good. An op that still owns a row meets the 404 itself.
          yield* eventRepo.deleteEvent(accountId, source, row.id);
        } else if (row.syncStatus === 'pending') {
          yield* eventRepo.markSynced(accountId, source, row.id);
        }
      }
      if (op.sourceGone === true) {
        yield* pendingOpRepo.forgetDeleted(accountId, source, [masterId]);
        // Nothing brought it back here since: gone from here too for a
        // move of it out of here that is queued behind this one.
        yield* pendingOpRepo.markSourceGone(
          others
            .filter(
              (queued) =>
                queued.kind === 'move' &&
                queued.eventId === masterId &&
                queued.calendarId === source,
            )
            .map((queued) => queued.id),
        );
      }
    });

  /**
   * A move Google made: its answer (`response`; none for a 2xx that did
   * not decode, whose rows keep what they show) settles the master, and
   * the exceptions, which moved with it, go back to sync. A row a queued
   * edit still owns stays pending until that op lands. No row at the
   * destination means the user moved it on again (or deleted it) while
   * this op waited: those later ops own the rows now.
   */
  /**
   * Whether Google's copy after a move is what the ops queued behind it
   * were built on — only the etag moved: none is parked, and the copy
   * each reads equals Google's in every field we keep. Asked before
   * `settle` moves that copy on. `theirsIn` is Google's version, read
   * with the zone an event without one takes.
   */
  const onlyMoved = (
    op: PendingOp,
    destination: string,
    theirsIn: (zone: string) => EventRecord | null,
  ) =>
    Effect.map(
      pendingOpRepo.listForEvent({
        accountId: op.accountId,
        calendarId: destination,
        eventId: op.eventId,
      }),
      (queued) =>
        queued.every((other) => {
          if (other.conflictAt !== undefined) {
            return false;
          }
          const before = other.beforePayload;
          if (!before) {
            return true;
          }
          const theirs = theirsIn(before.startTimeZone ?? 'UTC');
          return theirs !== null && Object.keys(changedFields(before, theirs)).length === 0;
        }),
    );

  /**
   * events.move gives the event a new etag (`produced`); when nothing else
   * changed (`onlyMoved`), what was built on an etag from before it — an
   * edit, answer or delete made while it waited (a delete leaves no row to
   * read it from), a move onwards, and the row such an edit holds — moves
   * to the new one, as after a write of our own. Sent as it was, it met a
   * 412 and parked a conflict nobody caused. With another change on
   * Google it keeps its etag and meets that conflict. Released instead,
   * the move leaves them their etag, still Google's in the source.
   */
  const advancePastMove = (op: PendingOp, destination: string, produced: string) =>
    transaction(
      Effect.gen(function* () {
        const event = { accountId: op.accountId, calendarId: destination, eventId: op.eventId };
        const stale = new Set<string>();
        for (const queued of yield* pendingOpRepo.listForEvent(event)) {
          if (queued.baseEtag !== undefined && queued.baseEtag !== produced) {
            stale.add(queued.baseEtag);
          }
        }
        for (const from of stale) {
          yield* pendingOpRepo.advanceBaseEtag(event, from, produced, op);
        }
        const row = yield* eventRepo.getById(op.accountId, destination, op.eventId);
        if (row?.etag != null && row.etag !== produced) {
          yield* eventRepo.advanceEtag(event, row.etag, produced);
        }
      }),
    );

  const landMove = (
    op: PendingOp,
    destination: string,
    answer: GcalEvent | undefined,
    pulled?: EventRecord,
  ) =>
    Effect.gen(function* () {
      const local = yield* eventRepo.getById(op.accountId, destination, op.eventId);
      const now = yield* Clock.currentTimeMillis;
      // Google's version in the destination: the record a pull's page of
      // that calendar brought (`acknowledge`), or the move's own answer.
      const theirsIn = (zone: string): EventRecord | null =>
        pulled ??
        (answer === undefined
          ? null
          : mapGcalEvent(answer, {
              accountId: op.accountId,
              calendarId: destination,
              defaultTimeZone: zone,
              syncedAt: now,
            }));
      const response = pulled ?? answer;
      const unchanged = response !== undefined && (yield* onlyMoved(op, destination, theirsIn));
      if (response) {
        const event = { accountId: op.accountId, calendarId: destination, eventId: op.eventId };
        const holding = (yield* pendingOpRepo.listForEvent(event)).find(
          (other) => other.id !== op.id && other.beforePayload != null,
        );
        const synced = theirsIn(
          local?.startTimeZone ?? holding?.beforePayload?.startTimeZone ?? 'UTC',
        );
        // Another device changed the event before the move landed. What
        // is queued behind the move is laid over Google's version while
        // its copy is still the one it was made on: advanced first, a
        // field that device changed read as the user's own, and was sent
        // back over it.
        if (synced && !unchanged) {
          yield* heldEvents.take(synced);
        }
        if (local) {
          yield* settle(op, synced, { calendarId: destination });
        } else if (synced && holding) {
          // Deleted here while the move waited: no row to settle, but what
          // that delete replaces is Google's copy in the destination now.
          yield* pendingOpRepo.advanceBefore(event, synced, op);
        }
      }
      const produced = response?.etag ?? undefined;
      if (unchanged && produced !== undefined) {
        yield* advancePastMove(op, destination, produced);
      }
      const queuedIds = new Set(
        (yield* pendingOpRepo.listAll())
          .filter((queued) => queued.id !== op.id && queued.accountId === op.accountId)
          .map((queued) => queued.eventId),
      );
      const rows = yield* seriesRows(op.accountId, destination, op.eventId);
      for (const row of rows) {
        if ((row.id !== op.eventId || !response) && !queuedIds.has(row.id)) {
          yield* eventRepo.markSynced(op.accountId, destination, row.id);
        }
      }
    });

  /**
   * A move's 404 is the event or the destination — or only that an
   * earlier attempt landed and its answer was lost, so the retry asked
   * the source, which has nothing any more. The destination decides:
   * there, the move landed; not there (or cancelled), Google never made
   * it, and the rows go back to the source — unless a pull already found
   * the event gone from there (`sourceGone`: another device deleted it,
   * and that page's token has moved on), when nothing goes back. One the
   * source's pull has not told of yet comes with its next page. A lookup
   * with no answer decides nothing: the move stays queued and asks again,
   * also one the user discarded (`PendingOp.discarded`): sent back as a
   * move that never reached Google, one that had landed left the event
   * shown in the source, and a change made there met a 404 and was lost.
   */
  const settleOrReleaseMove = (op: PendingOp): Effect.Effect<ApplyOutcome> =>
    Effect.gen(function* () {
      const destination = op.targetCalendarId;
      if (destination === undefined) {
        return 'done' as const;
      }
      const found = yield* Effect.result(
        client.getEvent({ accountId: op.accountId, calendarId: destination, eventId: op.eventId }),
      );
      if (found._tag === 'Success' && found.success.status !== 'cancelled') {
        yield* Effect.ignore(landMove(op, destination, found.success));
        return 'done' as const;
      }
      if (
        found._tag === 'Failure' &&
        found.failure._tag !== 'NotFoundError' &&
        found.failure._tag !== 'SyncTokenExpiredError'
      ) {
        return retry('Google did not say where the event is');
      }
      yield* releaseRow(op);
      return 'done' as const;
    });

  /**
   * After a change of a series was given up: the queued changes of its
   * occurrences at a slot the series does not draw without it — new times,
   * a new rule — go with it, row and all. They were made under it, Google
   * has no such occurrence, and sent, each met a 404 and was dropped then.
   * One of an occurrence Google has an exception for stays: that is there.
   */
  const dropUndrawn = (op: PendingOp) =>
    Effect.gen(function* () {
      const master =
        op.kind === 'update'
          ? yield* eventRepo.getById(op.accountId, op.calendarId, op.eventId)
          : null;
      if (!master) {
        return;
      }
      for (const queued of yield* pendingOpRepo.listAll()) {
        if (
          queued.accountId === op.accountId &&
          queued.calendarId === op.calendarId &&
          queued.eventId.startsWith(`${op.eventId}_`) &&
          queued.beforePayload === null &&
          queued.payload?.recurringEventId === op.eventId &&
          !drawsSlot(master, queued.payload)
        ) {
          yield* pendingOpRepo.remove(queued.id);
          yield* eventRepo.deleteEvent(queued.accountId, queued.calendarId, queued.eventId);
        }
      }
    });

  /** A rejection retrying cannot fix: say so, tell the UI, drop the op. */
  const drop = (
    op: PendingOp,
    reason: string,
    options: ReleaseOptions = {},
  ): Effect.Effect<ApplyOutcome> =>
    Effect.gen(function* () {
      yield* Effect.logWarning('pending op dropped', {
        eventId: op.eventId,
        kind: op.kind,
        reason,
      });
      // Replaced while this request was in flight: the replacement owns
      // the row now (and meets the same answer itself); nothing to put back.
      const queued = yield* Effect.orElseSucceed(pendingOpRepo.getById(op.id), () => op);
      if (queued === undefined) {
        return 'done' as const;
      }
      // Turned down for good, it takes along what was made under it, as
      // when the user gives it up. One that landed (a 2xx that did not
      // decode) keeps what follows it.
      const givenUp = options.revert ?? true;
      yield* releaseRow(op, options);
      if (givenUp) {
        yield* Effect.ignore(transaction(dropUndrawn(op)));
      }
      yield* Effect.ignore(notifyDropped);
      return 'done' as const;
    });

  /**
   * A delete is done, but a page answered before it reached Google may
   * have put Google's copy back while it was queued: a synced, live row
   * at its id. That copy goes. A cancelled override (one occurrence's
   * delete) stays, and a pending row is an op's queued since — read and
   * delete in one transaction, so an edit of the copy cannot slip between.
   * An occurrence's copy whose slot the master's rule still draws (put
   * back under a series that is Google's again) becomes the cancelled
   * tombstone Google has now, or the slot would show until a pull. The
   * delete's own tombstone (an occurrence delete's) is Google's now too,
   * once no other op owns it: left pending, nothing ever settled it. A
   * series takes its exceptions with it on Google, and their synced rows
   * go too (`dropSeriesExceptions`).
   */
  const dropPulledCopy = (op: PendingOp) =>
    transaction(
      Effect.gen(function* () {
        const row = yield* eventRepo.getById(op.accountId, op.calendarId, op.eventId);
        if (row?.syncStatus === 'synced' && row.status !== 'cancelled') {
          const master =
            row.recurringEventId === undefined
              ? null
              : yield* eventRepo.getById(op.accountId, op.calendarId, row.recurringEventId);
          yield* master && drawsSlot(master, row)
            ? eventRepo.upsertMany([new EventRecord({ ...row, status: 'cancelled' })])
            : eventRepo.deleteEvent(op.accountId, op.calendarId, op.eventId);
        } else if (
          row?.status === 'cancelled' &&
          row.syncStatus === 'pending' &&
          (yield* releasedStatus(op)) === 'synced'
        ) {
          yield* eventRepo.markSynced(op.accountId, op.calendarId, op.eventId);
        } else if (!row) {
          // An occurrence whose series delete waits with the master gone:
          // Google's copy of it is its cancellation now, which that delete
          // holds like the series' other exceptions — discarded, it must
          // not show the slot again.
          const copy = op.beforePayload ?? op.payload;
          if (copy?.recurringEventId !== undefined) {
            yield* takeIntoDelete(
              taken,
              new EventRecord({ ...copy, status: 'cancelled', syncStatus: 'synced' }),
            );
          }
        }
        yield* dropSeriesExceptions(taken, op.accountId, op.calendarId, op.eventId);
      }),
    );

  /** Google no longer has what the op writes to (404, or a 410 on a write). */
  const gone = (op: PendingOp) =>
    Effect.gen(function* () {
      // A delete is done: what it deletes is gone (an earlier attempt
      // landed, its response lost). Its local state already says so, and
      // for one occurrence of a series that state is a cancelled override
      // — deleting that row would bring the occurrence back, for good if
      // a pull already consumed Google's cancellation.
      if (op.kind === 'delete') {
        yield* dropPulledCopy(op);
        return 'done' as const;
      }
      // 404 is the task *or the destination list*: put the rows back where
      // Google last had them. A task really gone there arrives as the
      // source list's tombstone; deleting here could hide one that exists.
      if (op.kind === 'moveTask') {
        return yield* settleOrRevertTaskMove(op);
      }
      if (op.kind === 'move') {
        return yield* settleOrReleaseMove(op);
      }
      // The task, or the parent or sibling it was placed by, is gone: the
      // row goes back to where Google last had it, and a task really
      // deleted there arrives as the list's tombstone.
      if (op.kind === 'reorderTask') {
        return yield* drop(op, 'the task or its new neighbours are gone on Google');
      }
      // A create whose calendar or list is gone will not land: it goes as a
      // refused one does — its row, the subtasks and ops waiting on its
      // temp id, and what a copy holds of its source goes back.
      // Discarded while its request was out, its discard released it
      // already: released again, an Apple source was made twice.
      if (op.kind === 'create' || op.kind === 'createTask') {
        if (yield* Effect.orElseSucceed(pendingOpRepo.getById(op.id), () => op)) {
          yield* releaseRow(op);
        }
        return 'done' as const;
      }
      // Deleted remotely — drop the local copy too. (For deleteTask
      // this is simply "already gone".)
      if (TASK_KINDS.has(op.kind)) {
        if (op.taskListId) {
          yield* taskRepo.removeTask(op.accountId, op.taskListId, op.eventId);
        }
        yield* forgetCopy(op);
        if (op.kind === 'deleteTask') {
          yield* retireSubtaskDeletes(op);
        }
      } else {
        yield* eventRepo.deleteEvent(op.accountId, op.calendarId, op.eventId);
      }
      return 'done' as const;
    });

  /**
   * Whether another op of the same event is queued (in `calendarId`, the
   * op's own unless a move put the event elsewhere). That op owns the row
   * now: a response written over it would put back what the user changed,
   * or deleted, since — its own response settles the row.
   */
  const othersQueued = (op: PendingOp, calendarId: string = op.calendarId) =>
    Effect.map(
      pendingOpRepo.listForEvent({ accountId: op.accountId, calendarId, eventId: op.eventId }),
      (queued) => queued.some((other) => other.id !== op.id),
    );

  /**
   * What landed is Google's copy of the event now, which the other queued
   * ops of it read. A synced row at a waiting delete's id (`isPulledCopy`)
   * is Google's and takes it too: the delete owns no row, and an edit
   * that replaces the delete starts from that row.
   */
  const advanceOthers = (
    op: PendingOp,
    event: { readonly accountId: string; readonly calendarId: string; readonly eventId: string },
    synced: EventRecord,
  ) =>
    Effect.gen(function* () {
      yield* pendingOpRepo.advanceBefore(event, synced, op);
      const row = yield* eventRepo.getById(event.accountId, event.calendarId, event.eventId);
      if (isPulledCopy(yield* pendingOpRepo.listForEvent(event), row)) {
        yield* eventRepo.upsertMany([synced]);
      } else {
        yield* heldEvents.show(event, op.id);
      }
    });

  /**
   * A landed series update that drops exceptions on Google forgets what
   * holds them. An update of the series that replaced it while it was out
   * inherited its drop: sending the same rule, it drops nothing more —
   * forgetting again when it lands would take the exceptions made since.
   */
  const forgetDroppedBy = (op: PendingOp, calendarId: string = op.calendarId) =>
    Effect.gen(function* () {
      const from = op.dropsFrom;
      if (op.kind !== 'update' || from === undefined || op.payload === undefined) {
        return;
      }
      yield* forgetDropped(taken, op.accountId, calendarId, op.eventId, op.payload, from, op.id);
      const rule = JSON.stringify(op.payload?.recurrence ?? null);
      const event = { accountId: op.accountId, calendarId, eventId: op.eventId };
      for (const other of yield* pendingOpRepo.listForEvent(event)) {
        if (
          other.id !== op.id &&
          other.kind === 'update' &&
          other.dropsFrom !== undefined &&
          JSON.stringify(other.payload?.recurrence ?? null) === rule
        ) {
          yield* pendingOpRepo.setDropsFrom(other.id, undefined);
        }
      }
    });

  /**
   * After the op's own write landed, in one transaction: when it was sent
   * with If-Match (`sentEtag`), the edits and deletes queued after it on
   * that etag — and the row a later edit still holds — move to the etag it
   * produced. Google checked `sentEtag`, so nothing else changed in
   * between, and a stale If-Match would 412 against the user's own edit.
   * One queued before it keeps its etag: it was built without this change
   * (advanceBaseEtag). A series update that drops exceptions on Google
   * forgets what still holds them (`forgetDropped`). Then Google's copy
   * settles the row, unless a later op owns it — or it is an exception
   * whose series delete waits with the master gone locally: then the copy
   * goes into that delete (`takeIntoDelete`; an answer survives a series
   * delete).
   */
  const settle = (
    op: PendingOp,
    synced: EventRecord | null,
    options: { readonly calendarId?: string; readonly sentEtag?: string | undefined } = {},
  ) =>
    transaction(
      Effect.gen(function* () {
        const calendarId = options.calendarId ?? op.calendarId;
        const event = { accountId: op.accountId, calendarId, eventId: op.eventId };
        yield* forgetDroppedBy(op, calendarId);
        const produced = synced?.etag ?? undefined;
        if (
          options.sentEtag !== undefined &&
          produced !== undefined &&
          produced !== options.sentEtag
        ) {
          yield* pendingOpRepo.advanceBaseEtag(event, options.sentEtag, produced, op);
          yield* eventRepo.advanceEtag(event, options.sentEtag, produced);
        }
        if (!synced) {
          return;
        }
        yield* advanceCarried(op, synced, calendarId);
        const held = yield* takeIntoDelete(taken, synced);
        if (yield* othersQueued(op, calendarId)) {
          if ((op.kind === 'rsvp' || op.kind === 'update') && options.sentEtag === undefined) {
            // Sent without If-Match (an answer after its 412, keep-mine):
            // the reply may hold another device's change too. To the ops
            // still queued it is Google's newer version, and they are
            // laid over it as over a pull's — taken as their copy as it
            // stands, what that device changed read as theirs to send.
            yield* heldEvents.take(synced, op.id);
          } else {
            // The row is theirs; what they replace is now what just landed.
            yield* advanceOthers(op, event, synced);
          }
        } else if (held) {
          // Google's copy is in the delete now; the op's own row goes.
          yield* eventRepo.deleteEvent(op.accountId, calendarId, op.eventId);
        } else {
          yield* eventRepo.upsertMany([synced]);
        }
      }),
    );

  /**
   * A series edit that carried text onto its exceptions landed: Google
   * carried it there too, so the queued edits of those exceptions now
   * replace the carried text, not the text the exceptions had before. One
   * queued before the series edit was built on the old text, and the
   * series edit, later, wins on what it carried (as when the two land in
   * order): its payload takes the carried text too. One queued after it
   * takes it in each field it did not change itself (its payload holds
   * the copy's value there): built on a row whose carry a landing or a
   * pull put Google's copy over, it held the old text. Sent as it was,
   * either put the old text back on that exception.
   */
  const advanceCarried = (op: PendingOp, synced: EventRecord, calendarId: string) =>
    Effect.gen(function* () {
      const carriedText = op.carriedText;
      if (!carriedText) {
        return;
      }
      // Google keeps no empty text: an empty field and a missing one are the same value.
      const changed = (field: CarriedField) =>
        (synced[field] ?? '') !== (carriedText.base[field] ?? '');
      const carried: Partial<EventRecord> = {
        ...(changed('description') ? { description: synced.description } : {}),
        ...(changed('location') ? { location: synced.location } : {}),
        ...(changed('title') ? { title: synced.title } : {}),
      };
      if (Object.keys(carried).length === 0) {
        return;
      }
      const before = new Set((yield* pendingOpRepo.earlierInSeries(op)).map((entry) => entry.id));
      for (const entry of carriedText.overrides) {
        const queued = yield* pendingOpRepo.listForEvent({
          accountId: op.accountId,
          calendarId,
          eventId: entry.eventId,
        });
        for (const other of queued) {
          if (other.beforePayload && other.conflictAt === undefined) {
            yield* pendingOpRepo.setBefore(
              other.id,
              withConsistentGeo(new EventRecord({ ...other.beforePayload, ...carried })),
            );
          }
          if (other.kind !== 'update' || !other.payload || other.conflictAt !== undefined) {
            continue;
          }
          const payload = other.payload;
          const taken = before.has(other.id)
            ? carried
            : Object.fromEntries(
                Object.entries(carried).filter(
                  ([field]) =>
                    (payload[field as CarriedField] ?? '') ===
                    (other.beforePayload?.[field as CarriedField] ?? ''),
                ),
              );
          if (Object.keys(taken).length > 0) {
            yield* pendingOpRepo.setPayload(
              other.id,
              withConsistentGeo(new EventRecord({ ...payload, ...taken })),
            );
          }
        }
      }
    });

  /**
   * A task write landed: `synced` is Google's copy now, and the row is
   * that with whatever is still queued for the task over it (an edit made
   * while this one was in flight) — or simply that.
   */
  const settleTask = (op: PendingOp, synced: TaskRecord) => transaction(held.land(op, synced));

  /** Google has the task no more (deleted there, or our delete landed): nothing to hold. */
  const forgetCopy = (op: PendingOp) =>
    Effect.gen(function* () {
      const copy = yield* held.copyOf(op.accountId, op.eventId);
      if (copy) {
        yield* taskRepo.removeCopies(op.accountId, copy.listId, [op.eventId]);
      }
    });

  /**
   * A create answered 409: an earlier attempt landed and its response was
   * lost. Fetch what Google has and write it, so the row stops being
   * `pending` (pulls skip pending rows — remote edits never arrived); a
   * later op of the event settles the row itself. Gone on Google: the row
   * goes too. A failed fetch retries the create, which 409s and fetches
   * again.
   */
  const settleLanded = (op: PendingOp): Effect.Effect<ApplyOutcome> =>
    Effect.gen(function* () {
      // A later op already owns the row: nothing to fetch for it.
      if (yield* othersQueued(op)) {
        return 'done' as const;
      }
      const item = yield* client
        .getEvent({ accountId: op.accountId, calendarId: op.calendarId, eventId: op.eventId })
        .pipe(Effect.catchTag('NotFoundError', () => Effect.succeed(undefined)));
      const landed = item
        ? mapGcalEvent(item, {
            accountId: op.accountId,
            calendarId: op.calendarId,
            defaultTimeZone: op.payload?.startTimeZone ?? 'UTC',
            syncedAt: yield* Clock.currentTimeMillis,
          })
        : undefined;
      // Checked after the fetch, with the write: an edit made while it was
      // in flight owns the row, and its own push settles it.
      yield* transaction(
        Effect.gen(function* () {
          if (yield* othersQueued(op)) {
            if (landed) {
              yield* advanceOthers(
                op,
                { accountId: op.accountId, calendarId: op.calendarId, eventId: op.eventId },
                landed,
              );
            }
            return;
          }
          if (landed) {
            yield* eventRepo.upsertMany([landed]);
          } else {
            yield* eventRepo.deleteEvent(op.accountId, op.calendarId, op.eventId);
          }
        }),
      );
      return 'done' as const;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed(
          retry(
            `fetching the event an earlier attempt created: ${describeFailure(Cause.squash(cause))}`,
          ),
        ),
      ),
    );

  /**
   * A 412: Google's copy moved on since the change was queued. Google's
   * version is fetched and becomes the event's copy, and every queued
   * change of the event is laid over it again (heldEvents.ts). An update
   * that changed something else than Google did goes again at once on
   * Google's etag, with Google's other fields in it: nobody is asked. One
   * that Google's version already holds (an earlier attempt landed, its
   * answer lost) is done. One that changed the same thing — or a guest
   * list, or a delete, which takes along what this app does not keep at
   * all — is parked with Google's version for the user to compare and
   * choose; the user's version stays on screen. A failed fetch retries the
   * whole op (it will 412 again and re-try the fetch).
   */
  const park = (op: PendingOp): Effect.Effect<ApplyOutcome, GoogleRequestError | SqlError> =>
    PARKABLE_KINDS.has(op.kind)
      ? client
          .getEvent({ accountId: op.accountId, calendarId: op.calendarId, eventId: op.eventId })
          .pipe(
            Effect.flatMap((item) =>
              Effect.gen(function* () {
                const theirs = mapGcalEvent(item, {
                  accountId: op.accountId,
                  calendarId: op.calendarId,
                  defaultTimeZone: op.payload?.startTimeZone ?? 'UTC',
                  syncedAt: yield* Clock.currentTimeMillis,
                });
                if (theirs && op.beforePayload) {
                  yield* transaction(heldEvents.take(theirs));
                }
                // Discarded or replaced while Google was asked.
                const current = yield* pendingOpRepo.getById(op.id);
                if (!current) {
                  return 'done' as const;
                }
                // Google already holds exactly what this update would send:
                // an earlier attempt landed and its response was lost, so
                // the retry's stale If-Match met our own write.
                if (
                  current.kind === 'update' &&
                  current.payload &&
                  theirs &&
                  JSON.stringify(updateBody(current, theirs)) ===
                    JSON.stringify(updateBody(current, current.payload))
                ) {
                  yield* settle(current, theirs);
                  return 'done' as const;
                }
                // Laid over Google's version without a clash: sent again at
                // once, on Google's etag. A second 412 there is a newer
                // change still, and meets the same check.
                if (
                  current.kind === 'update' &&
                  current.conflictAt === undefined &&
                  current.baseEtag !== op.baseEtag
                ) {
                  return yield* apply(current);
                }
                return { conflict: theirs };
              }),
            ),
            Effect.catchTag('NotFoundError', () => Effect.succeed({ conflict: null })),
          )
      : drop(op, 'changed on Google');

  /**
   * The create of a series a this-and-following edit split off, before it
   * is sent (splitSeries.ts): it waits while a change of the series it was
   * split from that carries the cut is queued, wherever that sits — sent
   * ahead, it stayed on Google when the cut was undone. Once that left the
   * queue Google is asked for the series (`splitCheck`): still drawing from
   * where this one starts, the cut was undone, and it goes with it. Then it
   * is stamped as sent in one transaction with checking that it is still
   * queued and nothing holds it or asks again: keep-theirs or an undo of
   * the cut committed after the checks found it unsent, and dropped it
   * while it went. One sent already waits for nothing: it may be there.
   * While a move of the series is queued it does not ask: Google has the
   * series in the source until the move lands, and in the destination it
   * found nothing.
   */
  const splitGate = (op: PendingOp): Effect.Effect<ApplyOutcome | undefined, SqlError> =>
    Effect.gen(function* () {
      const { accountId, splitIn, splitOf } = op;
      if (
        op.kind !== 'create' ||
        splitOf === undefined ||
        splitIn === undefined ||
        op.dispatchedAt !== undefined
      ) {
        return undefined;
      }
      const held = Effect.map(pendingOpRepo.listAll(), (queued) =>
        queued.some((entry) => ofSplitSeries(op, entry) && holdsSplit(entry)),
      );
      if (yield* held) {
        return retry('waiting for the series it was split from');
      }
      if (op.splitCheck === true) {
        const moving = (yield* pendingOpRepo.listAll()).some(
          (entry) =>
            entry.kind === 'move' &&
            entry.accountId === accountId &&
            entry.eventId === splitOf &&
            entry.targetCalendarId === splitIn,
        );
        if (moving) {
          return retry('waiting for the series it was split from to move');
        }
        const found = yield* Effect.result(
          client.getEvent({ accountId, calendarId: splitIn, eventId: splitOf }),
        );
        if (
          found._tag === 'Failure' &&
          found.failure._tag !== 'NotFoundError' &&
          found.failure._tag !== 'SyncTokenExpiredError'
        ) {
          return retry('asking Google about the series it was split from');
        }
        const series =
          found._tag === 'Success' && found.success.status !== 'cancelled'
            ? mapGcalEvent(found.success, {
                accountId,
                calendarId: splitIn,
                defaultTimeZone: op.payload?.startTimeZone ?? 'UTC',
                syncedAt: yield* Clock.currentTimeMillis,
              })
            : null;
        if ((yield* transaction(settleSplit(taken, op, series))) !== 'go') {
          return 'done' as const;
        }
      }
      const now = yield* Clock.currentTimeMillis;
      return yield* transaction(
        Effect.gen(function* () {
          const current = yield* pendingOpRepo.getById(op.id);
          if (!current) {
            return 'done' as const;
          }
          if (current.splitCheck === true || (yield* held)) {
            return retry('waiting for the series it was split from');
          }
          yield* pendingOpRepo.markDispatched(op.id, now);
          return undefined;
        }),
      );
    });

  /**
   * Whether a task op waits behind the task ops queued before it: a move
   * into its list, earlier changes in the list it moves or reorders in, a
   * reorder or a move out of the list it deletes from, the subtask created
   * before it.
   */
  const taskOrderGate = (op: PendingOp): Effect.Effect<ApplyOutcome | undefined, SqlError> =>
    Effect.gen(function* () {
      if (!TASK_KINDS.has(op.kind)) {
        return undefined;
      }
      // Task ops keep their order around a move even when backoff lets the
      // drain skip one: an op addressing a list a queued move goes into
      // (the moved task's later edits, its subtasks', a move onwards) waits
      // for that move — Google has nothing there yet, and the 404 would
      // drop the op and its row — and a move waits for what was queued
      // before it in its source list (a subtask's delete, say).
      const earlier = yield* pendingOpRepo.earlierTaskOps(op);
      if (
        earlier.some(
          (other) => other.kind === 'moveTask' && other.targetTaskListId === op.calendarId,
        )
      ) {
        return retry('waiting for the move ahead of it');
      }
      // A reorder names the parent and the sibling it goes after as the
      // list stands once everything queued before it landed, so it waits
      // for those; and a delete queued behind it must not take a sibling
      // it names away first.
      if (
        (op.kind === 'moveTask' || op.kind === 'reorderTask') &&
        earlier.some((other) => other.calendarId === op.calendarId)
      ) {
        return retry('waiting for earlier changes in its list');
      }
      if (
        op.kind === 'deleteTask' &&
        earlier.some((other) => other.kind === 'reorderTask' && other.calendarId === op.calendarId)
      ) {
        return retry('waiting for the reorder ahead of it');
      }
      // Google deletes a parent's subtasks with it: one the user moved out
      // of it first, its move waiting out a backoff, went along with it.
      if (
        op.kind === 'deleteTask' &&
        earlier.some((other) => other.kind === 'moveTask' && other.calendarId === op.calendarId)
      ) {
        return retry('waiting for the move ahead of it');
      }
      // Google inserts a subtask first among its siblings: they are
      // queued last to first, and each waits for the one before it so a
      // retry cannot swap them.
      if (
        op.kind === 'createTask' &&
        op.taskParent !== undefined &&
        earlier.some((other) => other.kind === 'createTask' && other.taskParent === op.taskParent)
      ) {
        return retry('waiting for the subtask before it');
      }
      return undefined;
    });

  /**
   * Whether an event op or a move waits behind the ops of its series
   * queued before it: a move behind any of them, the others behind a
   * move, the series' create and a change of the series' rule — and
   * behind the series they were split from (`splitGate`, which may also
   * settle the op or stamp its create).
   */
  const seriesOrderGate = (op: PendingOp): Effect.Effect<ApplyOutcome | undefined, SqlError> =>
    Effect.gen(function* () {
      if (op.kind !== 'move' && !EVENT_KINDS.has(op.kind)) {
        return undefined;
      }
      // A move and the edits of the same series keep their queue order even
      // when backoff lets listDue skip the older one: an edit queued before
      // the move patches the source calendar, one queued after patches the
      // destination — either would 404 on the wrong side of the move. An
      // occurrence edit (or RSVP) queued behind its series' create waits
      // for it the same way: Google has no instance to patch until then,
      // and the 404 would drop the edit.
      const earlier = yield* pendingOpRepo.earlierInSeries(op);
      const kinds = earlier.map((entry) => entry.kind);
      if (op.kind === 'move' && earlier.length > 0) {
        return retry('waiting for earlier changes to the event');
      }
      if (op.kind !== 'move' && kinds.includes('move')) {
        return retry('waiting for the move ahead of it');
      }
      if (op.kind !== 'create') {
        // Folding an edit into an unsent create keeps its createdAt but
        // gives it a new rowid, behind occurrence edits with the same
        // timestamp (a move gives the whole series one). Those edits
        // still need the series to exist on Google first.
        const series = yield* pendingOpRepo.listForEvent({
          accountId: op.accountId,
          calendarId: op.calendarId,
          eventId: op.payload?.recurringEventId ?? op.eventId,
        });
        if (kinds.includes('create') || series.some((entry) => entry.kind === 'create')) {
          return retry('waiting for the create ahead of it');
        }
      }
      const split = yield* splitGate(op);
      if (split !== undefined) {
        return split;
      }
      // A change of the series ahead of an occurrence's goes first: the
      // occurrence's was made under it. New times give the occurrence
      // another id on Google, where the old one answers 404 and the
      // change is lost; changed text is copied onto every exception, over
      // an occurrence's own that reached Google before it (verified live);
      // and a new rule, once it lands, forgets the exceptions it drops
      // (`forgetDropped`) — one made under it that landed while it waited
      // out a backoff (its answer lost, say) went too.
      if (
        op.kind !== 'move' &&
        earlier.some(
          (entry) => entry.kind === 'update' && op.eventId.startsWith(`${entry.eventId}_`),
        )
      ) {
        return retry('waiting for the change of its series ahead of it');
      }
      // A change of a series waits for the changes of its occurrences
      // made before it: its text is copied onto them, over their own, as
      // the user saw it here. (An event has one waiting update at most:
      // every edit goes into it, where it stands.)
      if (
        op.kind === 'update' &&
        earlier.some(
          (entry) => entry.kind === 'update' && entry.eventId.startsWith(`${op.eventId}_`),
        )
      ) {
        return retry('waiting for the change ahead of it');
      }
      return undefined;
    });

  /**
   * Whether an exception's delete waits for a queued change of its series'
   * rule that drops it (`dropsFrom`).
   */
  const exceptionDeleteGate = (op: PendingOp): Effect.Effect<ApplyOutcome | undefined, SqlError> =>
    Effect.gen(function* () {
      // An exception's delete waits for a change of its series' rule that
      // drops it wherever that sits: a series edit that replaced it went
      // to the back of the queue, and the deletes went out ahead of it —
      // past taking back once it was abandoned, and into a 412 for one
      // the user made (the PATCH gives every exception a new etag). Its
      // landing takes them off the queue (`forgetDropped`).
      const exception = op.kind === 'delete' ? op.payload : undefined;
      const masterId = exception?.recurringEventId;
      if (exception && masterId !== undefined && exception.id === op.eventId) {
        const start = exception.originalStartUtc ?? exception.startUtc;
        const changes = yield* pendingOpRepo.listForEvent({
          accountId: op.accountId,
          calendarId: op.calendarId,
          eventId: masterId,
        });
        if (
          changes.some(
            (entry) =>
              entry.kind === 'update' &&
              entry.dropsFrom !== undefined &&
              start >= entry.dropsFrom &&
              !(entry.payload && drawsSlot(entry.payload, exception)),
          )
        ) {
          return retry('waiting for the change of its series');
        }
      }
      return undefined;
    });

  /** A color change: patches the calendar-list entry and keeps Google's colors. */
  const sendCalendarColor = (op: PendingOp) =>
    Effect.gen(function* () {
      if (!op.colorHex) {
        return 'done' as const;
      }
      // The response echoes the final colors; upserting it self-heals
      // the case where a pull overwrote the optimistic value while
      // this op sat in backoff. upsertMany never touches is_visible.
      const entry = yield* client.patchCalendarListEntry({
        accountId: op.accountId,
        backgroundColor: op.colorHex,
        calendarId: op.calendarId,
        foregroundColor: contrastingTextColor(op.colorHex),
      });
      yield* calendarRepo.upsertMany([
        mapGcalCalendar(entry, {
          accountId: op.accountId,
          colorFromId: () => undefined,
          previousVisibility: undefined,
        }),
      ]);
      return 'done' as const;
    });

  /** A task done or not done: patches its status and settles the row with Google's copy. */
  const sendCompleteTask = (op: PendingOp) =>
    Effect.gen(function* () {
      if (!op.taskListId || !op.taskStatus) {
        return 'done' as const;
      }
      // The response echoes the final task; upserting it self-heals a
      // backoff-window pull overwrite, and for repeating tasks Google
      // materializes the next occurrence server-side on completion —
      // the following poll picks that up.
      const response = yield* tasksClient.patchTask({
        accountId: op.accountId,
        changes: { status: op.taskStatus },
        taskId: op.eventId,
        taskListId: op.taskListId,
      });
      const synced = mapGcalTask(response, {
        accountId: op.accountId,
        taskListId: op.taskListId,
      });
      if (synced) {
        yield* settleTask(op, synced);
      }
      return 'done' as const;
    });

  /**
   * The tasks an earlier attempt of a create may have landed: same title,
   * day, notes and parent, changed since the stamp (a minute's slack for
   * clocks). Every page is read: where many tasks changed since — a
   * "Clear completed" hides each one, an app closed for days between
   * attempts — the first page held other tasks and the retry inserted a
   * duplicate.
   */
  const findLanded = (op: PendingOp, taskListId: string, dispatchedAt: number) =>
    Effect.gen(function* () {
      const matches: Array<GcalTask> = [];
      let pageToken: string | undefined;
      do {
        const page = yield* tasksClient.listTasks({
          accountId: op.accountId,
          params: { pageToken, updatedMin: new Date(dispatchedAt - 60_000).toISOString() },
          taskListId,
        });
        for (const candidate of page.items ?? []) {
          if (
            !candidate.deleted &&
            (candidate.title ?? '') === op.taskTitle &&
            (candidate.due?.slice(0, 10) ?? undefined) === (op.taskDue ?? undefined) &&
            (candidate.notes ?? undefined) === op.taskNotes &&
            (candidate.parent ?? undefined) === op.taskParent
          ) {
            matches.push(candidate);
          }
        }
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined);
      return matches;
    });

  /**
   * Whether a match is the task this create's lost attempt made, as far
   * as Google can tell: what is adopted for a delete is deleted next, so a
   * twin of the user's must not pass. Open as Google made it (an insert
   * makes no completed task), made within two minutes of the stamp — no
   * request outlives that; a task changed since was changed elsewhere,
   * and its delete is no longer ours to send — and not a task a row here
   * already holds.
   */
  const madeBy = (op: PendingOp, dispatchedAt: number, taskListId: string, match: GcalTask) =>
    Effect.gen(function* () {
      const updated = match.updated === undefined ? Number.NaN : Date.parse(match.updated);
      if (
        match.status !== 'needsAction' ||
        !(updated >= dispatchedAt - 60_000 && updated <= dispatchedAt + 120_000)
      ) {
        return false;
      }
      return (yield* taskRepo.get(op.accountId, taskListId, match.id)) === undefined;
    });

  /**
   * The deletes queued behind a task's create: the user deleted the task
   * while its create was out (taskMutations deleteOne keeps a sent create).
   */
  const deletesBehind = (accountId: string, taskListId: string, taskId: string) =>
    Effect.map(
      pendingOpRepo.listForEvent({ accountId, calendarId: taskListId, eventId: taskId }),
      (queued) => queued.filter((other) => other.kind === 'deleteTask'),
    );

  /**
   * The create has Google's id now (`taskId`). Deleted while it was out,
   * the task stays gone here — a row of the one that landed too — and the
   * delete, which took that id, goes next instead of waiting out
   * the backoff it collected behind the temp id. Otherwise `show` writes
   * the row.
   */
  const settleCreatedTask = (
    op: PendingOp,
    taskListId: string,
    record: TaskRecord,
    show: Effect.Effect<void, SqlError>,
  ) =>
    Effect.gen(function* () {
      const taskId = record.id;
      yield* taskRepo.removeTask(op.accountId, taskListId, op.eventId);
      // What was queued behind the create holds the task now, on the copy
      // Google just made (`op` itself took the id too).
      const behind = (yield* pendingOpRepo.listForTask(op.accountId, taskId)).some(
        (queued) => queued.id !== op.id,
      );
      if (behind) {
        yield* taskRepo.putCopy(record);
      }
      const deletes = yield* deletesBehind(op.accountId, taskListId, taskId);
      if (deletes.length === 0) {
        yield* show;
        return yield* held.refresh(op.accountId, taskId, op.id);
      }
      yield* taskRepo.removeTask(op.accountId, taskListId, taskId);
      for (const queued of deletes) {
        yield* pendingOpRepo.makeDue(queued.id);
      }
    });

  /**
   * Swaps the temp id for Google's (`task`, inserted or adopted) everywhere
   * it can appear: the row itself and any ops queued behind this create
   * (processPendingOps drains oldest-first, so they run after). In one
   * transaction: a delete made between the swap and the row's write found
   * no create on the temp id, waited there forever and the task showed
   * again. Remove-then-upsert rather than UPDATE ... SET id: a poll may
   * already have upserted the server row, and a PK conflict here would
   * retry the op — re-running an insert the Tasks API cannot deduplicate
   * (ids are server-assigned, unlike events). The same non-idempotency
   * means a crash between the insert response and op removal can
   * duplicate a task; that window is accepted, this one is not.
   */
  const swapInTask = (
    op: PendingOp,
    taskListId: string,
    task: GcalTask,
    show: (record: TaskRecord) => Effect.Effect<void, SqlError>,
  ) =>
    transaction(
      Effect.gen(function* () {
        yield* pendingOpRepo.rewriteEventId(op.accountId, taskListId, op.eventId, task.id);
        yield* taskRepo.replaceParent(op.accountId, op.eventId, task.id);
        const record = mapGcalTask(task, { accountId: op.accountId, taskListId });
        if (record) {
          yield* settleCreatedTask(op, taskListId, record, show(record));
        } else {
          // Unreachable in practice (a task Google just made is never a
          // tombstone) — keep the row addressable under the server id.
          yield* taskRepo.replaceId(op.accountId, taskListId, op.eventId, task.id);
        }
        // Publish before the transaction's task invalidation reaches an open
        // detail. If commit fails, getTask still prefers the restored temp row.
        yield* taskRepo.rememberCreatedId(op.accountId, taskListId, op.eventId, task.id);
      }),
    );

  /**
   * A new task: adopts the one an earlier attempt landed, or inserts it,
   * then swaps the temp id for Google's. A blank title is a title: Google
   * holds tasks without one, and a moved subtask without one went nowhere.
   */
  const sendCreateTask = (op: PendingOp) =>
    Effect.gen(function* () {
      const { taskListId, taskTitle } = op;
      if (!taskListId || taskTitle === undefined) {
        return 'done' as const;
      }
      // A set dispatch stamp means an earlier attempt's insert may
      // have landed without us seeing the response (crash, dropped
      // connection). tasks.insert is not idempotent — ids are
      // server-assigned — so verify before inserting again: adopt an
      // exact field match updated since the stamp instead of creating
      // a duplicate. A false adopt needs an identical task created in
      // the same window elsewhere (and is benign); a miss is merely
      // the old behavior.
      if (op.dispatchedAt !== undefined) {
        const deleted = (yield* deletesBehind(op.accountId, taskListId, op.eventId)).length > 0;
        const matches: Array<GcalTask> = [];
        for (const match of yield* findLanded(op, taskListId, op.dispatchedAt)) {
          if (!deleted || (yield* madeBy(op, op.dispatchedAt, taskListId, match))) {
            matches.push(match);
          }
        }
        const adopted = matches.length === 1 ? matches[0] : undefined;
        if (adopted) {
          const now = yield* Clock.currentTimeMillis;
          yield* swapInTask(op, taskListId, adopted, (record) =>
            taskRepo.upsertTasks([record], now),
          );
          return 'done' as const;
        }
        // Deleted meanwhile, and it never landed: the delete behind it has
        // nothing to take, and inserting it now would only make a task
        // for that delete to remove. Moved on meanwhile, the copy it was
        // moved to takes over what it was copied from.
        const settled = yield* transaction(
          Effect.gen(function* () {
            const deletes = yield* deletesBehind(op.accountId, taskListId, op.eventId);
            if (deletes.length === 0) {
              return false;
            }
            yield* handOn(op);
            for (const queued of deletes) {
              yield* pendingOpRepo.remove(queued.id);
            }
            return true;
          }),
        );
        if (settled) {
          return 'done' as const;
        }
      }
      // Stamped only while still queued, in one transaction with the
      // check: a delete that came first took the unsent create with it,
      // and inserting it anyway left the deleted task on Google. A delete
      // after the stamp sees it sent and waits behind it. A retry keeps
      // the first stamp: what that attempt made is still in the window.
      if (op.dispatchedAt === undefined && !(yield* stampIfQueued(op))) {
        return 'done' as const;
      }
      const inserted = yield* tasksClient.insertTask({
        accountId: op.accountId,
        parent: op.taskParent,
        task: {
          title: taskTitle,
          ...(op.taskDue ? { due: `${op.taskDue}T00:00:00.000Z` } : {}),
          ...(op.taskNotes ? { notes: op.taskNotes } : {}),
        },
        taskListId,
      });
      yield* swapInTask(op, taskListId, inserted, (record) =>
        Effect.gen(function* () {
          // Google put it first among its siblings and renumbered them
          // without bumping their `updated`: here they still hold their
          // old places, and its "…00" would tie with the first one's.
          // It goes first here too until the next pass, which sees the
          // list's `updated` move and reads the order back.
          const siblings = (yield* taskRepo.listSiblings(
            op.accountId,
            taskListId,
            record.parentId,
          )).filter((sibling) => sibling.id !== record.id);
          yield* taskRepo.upsertTasks(
            [
              placedTask(record, {
                ...(record.parentId === undefined ? {} : { parentId: record.parentId }),
                position: provisionalPosition(siblings, undefined),
              }),
            ],
            yield* Clock.currentTimeMillis,
          );
        }),
      );
      return 'done' as const;
    });

  /**
   * Stamps a create as sent, only while it is still queued — in one
   * transaction with that check. A delete (or an edit that replaced it)
   * that came between the drain's read and the stamp took the unsent
   * create; inserting it anyway put back on Google what the user deleted,
   * or sent the stale fields. Whether it was stamped.
   */
  const stampIfQueued = (op: PendingOp): Effect.Effect<boolean, SqlError> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* transaction(
        Effect.gen(function* () {
          if (!(yield* pendingOpRepo.getById(op.id))) {
            return false;
          }
          yield* pendingOpRepo.markDispatched(op.id, now);
          return true;
        }),
      );
    });

  /** A new event: stamped as sent, inserted, and settled with Google's copy. */
  const sendCreate = (op: PendingOp, guestMode: GuestNotificationMode) =>
    Effect.gen(function* () {
      if (!op.payload) {
        // Stored payload no longer decodes (a schema moved on): nothing
        // to send, and the user should know the edit is gone.
        return yield* drop(op, 'stored payload unreadable');
      }
      // From here on Google may have the event even if the response
      // never arrives (its retry then answers 409, which counts as
      // done): a later edit must not fold into this create, nor a
      // delete simply drop it (mutations.ts unsentCreateOf).
      if (op.dispatchedAt === undefined && !(yield* stampIfQueued(op))) {
        return 'done' as const;
      }
      const response = yield* client.insertEvent({
        accountId: op.accountId,
        calendarId: op.calendarId,
        event: {
          ...toGcalEventInput(op.payload),
          ...toGcalGeoInsert(op.payload),
          ...toGcalRemindersInsert(op.payload),
          attendees: toGcalAttendees(op.payload),
        },
        sendUpdates: sendUpdatesFor(op.payload, false, guestMode),
      });
      yield* settle(
        op,
        mapGcalEvent(response, {
          accountId: op.accountId,
          calendarId: op.calendarId,
          defaultTimeZone: op.payload.startTimeZone ?? 'UTC',
          syncedAt: yield* Clock.currentTimeMillis,
        }),
      );
      return 'done' as const;
    });

  /** An event delete: sent on its etag, then a synced copy still at its id goes. */
  const sendDelete = (op: PendingOp) =>
    Effect.gen(function* () {
      yield* client.deleteEvent({
        accountId: op.accountId,
        baseEtag: op.baseEtag,
        calendarId: op.calendarId,
        eventId: op.eventId,
      });
      yield* dropPulledCopy(op);
      return 'done' as const;
    });

  /**
   * A task move to another list: stamped as sent while it is still
   * queued, sent, then settled in the destination. A discard that finds
   * the stamp asks Google where the task is before putting anything back
   * (settleDiscardedMove), as for an event move.
   */
  const sendMoveTask = (op: PendingOp) =>
    Effect.gen(function* () {
      const destination = op.targetTaskListId;
      if (!destination || !op.taskListId) {
        return yield* drop(op, 'task move without a destination');
      }
      if (op.dispatchedAt === undefined && !(yield* stampIfQueued(op))) {
        return 'done' as const;
      }
      const response = yield* tasksClient.moveTask({
        accountId: op.accountId,
        destinationTaskListId: destination,
        taskId: op.eventId,
        taskListId: op.taskListId,
      });
      yield* settleTaskMove(op, destination, response);
      return 'done' as const;
    });

  /**
   * A task reorder: dropped when it would nest the task two levels deep,
   * otherwise sent, and the list's order read back.
   */
  const sendReorderTask = (op: PendingOp) =>
    Effect.gen(function* () {
      if (!op.taskListId) {
        return 'done' as const;
      }
      // Checked again as sent: a change undone since it was queued (a
      // subtask put back under the task, the new parent nested itself)
      // would make Google nest it two levels deep, which it accepts.
      if (op.taskParent !== undefined) {
        const parent = yield* taskRepo.get(op.accountId, op.taskListId, op.taskParent);
        const subtasks = yield* taskRepo.listSubtasks(op.accountId, op.taskListId, op.eventId);
        if (parent?.parentId !== undefined || subtasks.length > 0) {
          return yield* drop(op, 'it would nest the task more than one level deep');
        }
      }
      const response = yield* tasksClient.moveTask({
        accountId: op.accountId,
        parent: op.taskParent,
        previous: op.taskPrevious,
        taskId: op.eventId,
        taskListId: op.taskListId,
      });
      const synced = mapGcalTask(response, {
        accountId: op.accountId,
        taskListId: op.taskListId,
      });
      if (synced) {
        yield* settleTask(op, synced);
      }
      yield* refreshTaskOrder(op, op.taskListId);
      return 'done' as const;
    });

  /** A task delete: sent, then its synced row and its subtasks' queued deletes go. */
  const sendDeleteTask = (op: PendingOp) =>
    Effect.gen(function* () {
      if (!op.taskListId) {
        return 'done' as const;
      }
      yield* tasksClient.deleteTask({
        accountId: op.accountId,
        taskId: op.eventId,
        taskListId: op.taskListId,
      });
      // A listing answered before the delete reached Google may have
      // put the task back meanwhile (synced); a queued op's row stays.
      yield* taskRepo.removeSyncedTask(op.accountId, op.taskListId, op.eventId);
      yield* forgetCopy(op);
      yield* retireSubtaskDeletes(op);
      return 'done' as const;
    });

  /**
   * An event move: stamped as sent while it is still queued, sent, and
   * landed in the destination.
   */
  const sendMove = (op: PendingOp, guestMode: GuestNotificationMode) =>
    Effect.gen(function* () {
      const destination = op.targetCalendarId;
      if (!destination) {
        return yield* drop(op, 'move without a destination');
      }
      // Stamped before the request, in one transaction with the check
      // that it is still queued: a discard came first (nothing goes
      // out), or it sees the stamp and asks Google before putting
      // anything back (settleDiscardedMove).
      const sending = yield* transaction(
        Effect.gen(function* () {
          const queued = yield* pendingOpRepo.getById(op.id);
          if (queued) {
            yield* pendingOpRepo.markDispatched(op.id, yield* Clock.currentTimeMillis);
          }
          return queued !== undefined;
        }),
      );
      if (!sending) {
        return 'done' as const;
      }
      const local = yield* eventRepo.getById(op.accountId, destination, op.eventId);
      const response = yield* client.moveEvent({
        accountId: op.accountId,
        calendarId: op.calendarId,
        destination,
        eventId: op.eventId,
        sendUpdates: local && hasGuests(local) ? guestMode : undefined,
      });
      yield* landMove(op, destination, response);
      return 'done' as const;
    });

  /** An RSVP: sends the guests' answers alone and settles the row with Google's copy. */
  const sendRsvp = (op: PendingOp) =>
    Effect.gen(function* () {
      if (!op.payload?.attendees) {
        return 'done' as const;
      }
      // Google's guests with the answers over them, not the row's: the row
      // may show a guest-list edit that is still queued — parked, even —
      // and an answer is no place to send that. Google replaces the whole
      // list with what a PATCH names.
      const guests = op.beforePayload?.attendees
        ? (withAnswers(op.beforePayload, op, op.beforePayload).attendees ?? op.payload.attendees)
        : op.payload.attendees;
      const attendees = guests.map((attendee) => ({
        email: attendee.email,
        responseStatus: attendee.responseStatus,
      }));
      const send = (baseEtag: string | undefined) =>
        client.patchEvent({
          accountId: op.accountId,
          baseEtag,
          calendarId: op.calendarId,
          event: { attendees },
          eventId: op.eventId,
        });
      // Attendees-only patch, first with If-Match on the etag the RSVP
      // was queued against. When that holds, Google had exactly the
      // version the queued edits were built on, so they move to the
      // etag this produced (an edit right behind an RSVP used to park
      // against it). A 412 sends it again unchecked — an RSVP should
      // not lose to unrelated content edits — and then nothing says
      // what Google had before: queued edits keep their etag, and a
      // 412 there asks the user.
      const sent = yield* send(op.baseEtag).pipe(
        Effect.map((response) => ({ response, sentEtag: op.baseEtag })),
        Effect.catchTag('ConflictError', () =>
          Effect.map(send(undefined), (response) => ({ response, sentEtag: undefined })),
        ),
      );
      yield* settle(
        op,
        mapGcalEvent(sent.response, {
          accountId: op.accountId,
          calendarId: op.calendarId,
          defaultTimeZone: op.payload.startTimeZone ?? 'UTC',
          syncedAt: yield* Clock.currentTimeMillis,
        }),
        { sentEtag: sent.sentEtag },
      );
      return 'done' as const;
    });

  /** An event edit: patches what it changed and settles the row with Google's copy. */
  const sendUpdate = (op: PendingOp, guestMode: GuestNotificationMode) =>
    Effect.gen(function* () {
      if (!op.payload) {
        // Stored payload no longer decodes (a schema moved on): nothing
        // to send, and the user should know the edit is gone.
        return yield* drop(op, 'stored payload unreadable');
      }
      const response = yield* client.patchEvent({
        accountId: op.accountId,
        baseEtag: op.baseEtag,
        calendarId: op.calendarId,
        event: changedBody(op, op.payload),
        eventId: op.eventId,
        // Removed guests get their cancellation too: flagged edits
        // always notify, even when nobody is left.
        sendUpdates: sendUpdatesFor(op.payload, op.attendeesChanged === true, guestMode),
      });
      // A second drag made while this patch was in flight queued a new
      // update on the same etag: it now follows this write.
      yield* settle(
        op,
        mapGcalEvent(response, {
          accountId: op.accountId,
          calendarId: op.calendarId,
          defaultTimeZone: op.payload.startTimeZone ?? 'UTC',
          syncedAt: yield* Clock.currentTimeMillis,
        }),
        { sentEtag: op.baseEtag },
      );
      return 'done' as const;
    });

  /** A task edit: patches its title, notes or day and settles the row with Google's copy. */
  const sendUpdateTask = (op: PendingOp) =>
    Effect.gen(function* () {
      if (!op.taskListId) {
        return 'done' as const;
      }
      const patched = yield* tasksClient.patchTask({
        accountId: op.accountId,
        changes: {
          // null takes the day away (JSON null clears a field on PATCH).
          ...(op.taskDue === undefined
            ? {}
            : { due: op.taskDue === null ? null : `${op.taskDue}T00:00:00.000Z` }),
          ...(op.taskNotes === undefined ? {} : { notes: op.taskNotes }),
          ...(op.taskTitle === undefined ? {} : { title: op.taskTitle }),
        },
        taskId: op.eventId,
        taskListId: op.taskListId,
      });
      const patchedRecord = mapGcalTask(patched, {
        accountId: op.accountId,
        taskListId: op.taskListId,
      });
      if (patchedRecord) {
        yield* settleTask(op, patchedRecord);
      }
      return 'done' as const;
    });

  const apply = (op: PendingOp): Effect.Effect<ApplyOutcome> =>
    Effect.gen(function* () {
      const guestMode = yield* GuestNotifications;
      const waiting =
        tempIdGate(op) ??
        (yield* taskOrderGate(op)) ??
        (yield* seriesOrderGate(op)) ??
        (yield* exceptionDeleteGate(op)) ??
        (yield* copyGate(op));
      if (waiting !== undefined) {
        return waiting;
      }
      switch (op.kind) {
        case 'calendarColor':
          return yield* sendCalendarColor(op);
        case 'completeTask':
          return yield* sendCompleteTask(op);
        case 'createTask':
          return yield* sendCreateTask(op);
        case 'create':
          return yield* sendCreate(op, guestMode);
        case 'delete':
          return yield* sendDelete(op);
        case 'moveTask':
          // Given up: never sent again, only settled.
          return yield* op.discarded ? settleOrRevertTaskMove(op) : sendMoveTask(op);
        case 'reorderTask':
          return yield* sendReorderTask(op);
        case 'deleteTask':
          return yield* sendDeleteTask(op);
        case 'move':
          return yield* op.discarded ? settleOrReleaseMove(op) : sendMove(op, guestMode);
        case 'rsvp':
          return yield* sendRsvp(op);
        case 'update':
          return yield* sendUpdate(op, guestMode);
        case 'updateTask':
          return yield* sendUpdateTask(op);
      }
    }).pipe(
      Effect.catchTags({
        ConflictError: () => park(op),
        GoogleApiError: (error) =>
          // 409 on insert = the idempotent create already landed. Other
          // 4xx are permanent (e.g. a rejected color patch) — retrying a
          // bad request forever would pin the queue, so the op is dropped
          // and the UI told; it used to vanish without a trace.
          error.status === 409
            ? op.kind === 'create'
              ? settleLanded(op)
              : Effect.succeed('done' as const)
            : error.status >= 200 && error.status < 300
              ? // A 2xx whose body did not decode is a schema bug on our
                // side; retrying it forever at the 30-minute cap fixes
                // nothing. The write landed, so the row keeps the change
                // and the next pull settles it.
                Effect.andThen(
                  Effect.ignore(transaction(forgetDroppedBy(op))),
                  drop(op, `${error.status}: ${error.message}`, { revert: false }),
                )
              : error.status >= 400 && error.status < 500 && error.status !== 429
                ? drop(op, `${error.status}: ${error.message}`)
                : Effect.succeed(retry(`${error.status}: ${error.message}`)),
        // The scope vanished after the op was queued (consent revoked, or
        // the enable flag was stale): this push can never succeed, so
        // retrying would pin the queue forever. Drop it, which hands the
        // row back (pulls skip pending rows, so a task op that only
        // disabled tasks left it stuck); for a task op also disable tasks
        // for the account — the connect row reappears in the UI. A
        // calendar op cannot lose the tasks scope.
        InsufficientScopeError: (error) =>
          Effect.andThen(
            TASK_KINDS.has(op.kind)
              ? Effect.ignore(accountRepo.setTasksEnabled(op.accountId, false))
              : Effect.void,
            drop(op, `insufficient scope: ${error.message}`),
          ),
        NotFoundError: () => gone(op),
        // Keep the op; flag the account so the UI offers a reconnect and
        // the queue drains after the user signs in again.
        ReauthRequiredError: () =>
          Effect.as(
            Effect.ignore(accountRepo.setStatus(op.accountId, 'reauth_required')),
            retry('signed out — reconnect the account'),
          ),
        // failForStatus reads every 410 as an expired sync token; on a
        // write it is Google's "deleted". Taken as done, an edit left its
        // row pending — pulls skip pending rows — so the deletion never
        // showed.
        SyncTokenExpiredError: () => gone(op),
      }),
      // Anything else (network, a defect): keep the op, record why.
      Effect.catchCause((cause) => {
        const reason = describeFailure(Cause.squash(cause));
        return Effect.as(
          Effect.logWarning('pending op failed, will retry', {
            eventId: op.eventId,
            kind: op.kind,
            reason,
          }),
          retry(reason),
        );
      }),
    );

  /**
   * A move the user gave up after it was sent: Google says where the item
   * is, and the move is settled there or put back. `done` once it did.
   */
  const settleDiscardedMove = (op: PendingOp): Effect.Effect<ApplyOutcome> =>
    op.kind === 'moveTask' ? settleOrRevertTaskMove(op, true) : settleOrReleaseMove(op);

  const acknowledge = (op: PendingOp, record: EventRecord): Effect.Effect<boolean> => {
    if (op.kind === 'create') {
      // The record may hold what another device changed since the create
      // landed: what is queued behind the create is laid over it first.
      return Effect.orElseSucceed(
        Effect.as(
          Effect.andThen(transaction(heldEvents.take(record, op.id)), settle(op, record)),
          true,
        ),
        () => false,
      );
    }
    return op.kind === 'move' && op.targetCalendarId !== undefined
      ? Effect.orElseSucceed(
          Effect.as(landMove(op, op.targetCalendarId, undefined, record), true),
          () => false,
        )
      : Effect.succeed(false);
  };

  return {
    acknowledge,
    apply,
    dropUndrawn,
    releaseAccountCopies,
    releaseRow,
    settleDiscardedMove,
  };
};
