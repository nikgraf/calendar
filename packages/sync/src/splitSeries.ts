import {
  type EventRecord,
  expandRecurringEvent,
  type PendingOp,
  recurrenceEndUtc,
  recurrenceMasterOf,
} from '@calendar/core';
import { Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import type { TakenDeps } from './takenExceptions.ts';

/**
 * A this-and-following edit cuts the series it edits and queues the
 * create of a new series from the edited occurrence on, which names where
 * it came from (`splitOf`, `splitAt`). Google gets the two as one change:
 * the create waits for the cut (`holdsSplit`), and goes with it if the cut
 * is undone. Either one alone showed those occurrences twice on Google.
 *
 * Whether the cut was undone, Google says: a discard may meet its request
 * on the way or landed with the answer lost, a rejection's revert may fail,
 * another device may have ended the series. So once an undo took the cut
 * from the queue, the create asks Google for the series before it goes
 * (`askSplits`, `settleSplit`), and goes with the cut where that still
 * draws from where it starts (`drawsFrom`); once the drain is done with
 * it, a landing wrote Google's copy to the table, and only a series that
 * is not that asks (`releaseSplits`). Keep-theirs has Google's copy at
 * hand and decides at once (`dropSplitSeries`).
 *
 * A split of a series whose create is unsent took the cut into that
 * create, which nothing undoes without the series: it names what that one
 * was split from, at the same occurrence, or nothing.
 */

/**
 * Whether `op`, queued for the series a create was split from, holds that
 * create back: the cut, or a series change that replaced it (an update
 * that drops exceptions), or a series delete that replaced it.
 */
export const holdsSplit = (op: PendingOp): boolean =>
  op.kind === 'delete' || (op.kind === 'update' && op.dropsFrom !== undefined);

/** How far past `from` a series whose end cannot be told is looked at. */
const HORIZON_MS = 5 * 366 * 24 * 60 * 60 * 1000;

/**
 * Whether the master's rule draws an occurrence that starts at `from` or
 * later — one found, not assumed: up to the series' end, or five years on
 * when that cannot be told (an endless rule, or one too long to enumerate,
 * as a series from decades ago with RDATE lines; taken as drawing on, a cut
 * one dropped the new series Google had). A master without a rule draws
 * nothing, and neither does a deleted one or a rule that cannot be read:
 * no proof that a cut was undone.
 */
export const drawsFrom = (master: EventRecord, from: number): boolean => {
  if (master.status === 'cancelled' || !master.recurrence?.length) {
    return false;
  }
  const rule = recurrenceMasterOf(master);
  try {
    const end = recurrenceEndUtc(rule) ?? from + HORIZON_MS;
    // A millisecond either side: the expansion keeps what overlaps the
    // range, and an occurrence with no duration at either end overlaps
    // nothing.
    return (
      end >= from &&
      expandRecurringEvent(rule, from - 1, end + 1).some(
        (instance) => instance.originalStartUtc >= from,
      )
    );
  } catch {
    return false;
  }
};

/** An occurrence's id is the master's, `_` and its original start. */
const inSeries = (masterId: string, eventId: string) =>
  eventId === masterId ||
  (eventId.startsWith(`${masterId}_`) && /\d/.test(eventId.charAt(masterId.length + 1)));

/** The unsent creates of the series split off `change`'s series. */
const splitsOf = (
  { pendingOpRepo }: TakenDeps,
  change: PendingOp,
): Effect.Effect<ReadonlyArray<PendingOp>, SqlError> =>
  Effect.map(pendingOpRepo.listAll(), (queued) =>
    queued.filter(
      (op) =>
        op.kind === 'create' &&
        op.accountId === change.accountId &&
        op.splitOf === change.eventId &&
        op.dispatchedAt === undefined,
    ),
  );

/** A split-off series' rows: the master and its overrides. */
const hideSeries = ({ eventRepo }: TakenDeps, create: PendingOp) =>
  Effect.gen(function* () {
    const { accountId, calendarId, eventId } = create;
    for (const override of yield* eventRepo.listOverrides(accountId, calendarId, eventId)) {
      yield* eventRepo.deleteEvent(accountId, calendarId, override.id);
    }
    yield* eventRepo.deleteEvent(accountId, calendarId, eventId);
  });

/**
 * A split-off series an undo hid that goes on after all: its rows as its
 * queued ops wrote them — the master its create sends, an occurrence's last
 * edit or tombstone. Brought back by the landing ops alone, a deleted
 * occurrence showed again: a landed delete puts no tombstone back.
 */
const showSeries = ({ eventRepo, pendingOpRepo }: TakenDeps, create: PendingOp) =>
  Effect.gen(function* () {
    const rows = new Map<string, EventRecord>();
    for (const op of yield* pendingOpRepo.listAll()) {
      if (
        op.payload &&
        op.accountId === create.accountId &&
        op.calendarId === create.calendarId &&
        inSeries(create.eventId, op.eventId)
      ) {
        rows.set(op.eventId, op.payload);
      }
    }
    yield* eventRepo.upsertMany([...rows.values()]);
  });

/** A split-off series that goes with its cut: everything queued for it, and its rows. */
const dropSeries = (deps: TakenDeps, create: PendingOp) =>
  Effect.gen(function* () {
    for (const op of yield* deps.pendingOpRepo.listAll()) {
      if (
        op.accountId === create.accountId &&
        op.calendarId === create.calendarId &&
        inSeries(create.eventId, op.eventId)
      ) {
        yield* deps.pendingOpRepo.remove(op.id);
      }
    }
    yield* hideSeries(deps, create);
  });

/**
 * An undo took `change` (a cut, or a series delete that replaced one) from
 * the queue: a discard or a rejection for good. The series split off it
 * ask Google before they go, in its calendar (`settleSplit`), and are due
 * at once — they waited out a backoff that grew while the cut waited.
 * Their rows go now: the series is back, and shows those days itself; if
 * Google kept the cut after all, they come back (`settleSplit`).
 */
export const askSplits = (deps: TakenDeps, change: PendingOp): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    for (const create of yield* splitsOf(deps, change)) {
      yield* deps.pendingOpRepo.setSplitCheck(create.id, change.calendarId);
      yield* deps.pendingOpRepo.makeDue(create.id);
      yield* hideSeries(deps, create);
    }
  });

/**
 * The drain is done with `change`: it landed, Google refused it, or the
 * series is gone there. The series split off it are due at once. The
 * master on the table says whether the cut is on Google when it is
 * Google's copy (synced: a landing wrote it; none: gone) and ends before a
 * split starts; otherwise (the user's own, pending: a rejection whose
 * revert failed) the split asks Google first. One an undo had ask keeps
 * that calendar: a same-id series elsewhere says nothing of it.
 */
export const releaseSplits = (deps: TakenDeps, change: PendingOp): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    const { accountId, calendarId, eventId } = change;
    const master = yield* deps.eventRepo.getById(accountId, calendarId, eventId);
    for (const create of yield* splitsOf(deps, change)) {
      if (
        create.splitCheck === undefined &&
        master !== null &&
        (master.syncStatus !== 'synced' ||
          (create.splitAt !== undefined && drawsFrom(master, create.splitAt)))
      ) {
        yield* deps.pendingOpRepo.setSplitCheck(create.id, calendarId);
      }
      yield* deps.pendingOpRepo.makeDue(create.id);
    }
  });

/**
 * Keep-theirs took `change` back, with Google's copy of the series
 * (`series`; null: gone there): a series split off it goes with it where
 * that still draws from where it starts, and is due at once otherwise.
 */
export const dropSplitSeries = (
  deps: TakenDeps,
  change: PendingOp,
  series: EventRecord | null,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    for (const create of yield* splitsOf(deps, change)) {
      if (series && create.splitAt !== undefined && drawsFrom(series, create.splitAt)) {
        yield* dropSeries(deps, create);
      } else {
        yield* deps.pendingOpRepo.makeDue(create.id);
      }
    }
  });

/**
 * Google's answer for the series a create asked about (`series`; null:
 * gone there): still drawing from where the create starts, the cut was
 * undone, and the new series goes with it; otherwise the create goes on,
 * and the rows an undo hid come back. What happened to the create.
 */
export const settleSplit = (
  deps: TakenDeps,
  create: PendingOp,
  series: EventRecord | null,
): Effect.Effect<'dropped' | 'go' | 'gone', SqlError> =>
  Effect.gen(function* () {
    const current = yield* deps.pendingOpRepo.getById(create.id);
    if (!current) {
      return 'gone';
    }
    if (series && current.splitAt !== undefined && drawsFrom(series, current.splitAt)) {
      yield* dropSeries(deps, current);
      return 'dropped';
    }
    yield* deps.pendingOpRepo.setSplitCheck(current.id, undefined);
    yield* showSeries(deps, current);
    return 'go';
  });

/** Whether `change` holds back an unsent create split off its series. */
export const waitingSplits = (
  deps: TakenDeps,
  change: PendingOp,
): Effect.Effect<boolean, SqlError> =>
  holdsSplit(change)
    ? Effect.map(splitsOf(deps, change), (splits) => splits.length > 0)
    : Effect.succeed(false);
