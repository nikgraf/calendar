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
 * the create waits for the cut (`holdsSplit`), and an undone cut takes it
 * along (`dropSplitSeries`). Either one alone showed those occurrences
 * twice on Google. A split of a series whose create is still unsent took
 * the cut into that create, which nothing can undo without the series: it
 * names the series that one was split from, if any (all of them wait for
 * that one's cut, and go with it), or nothing.
 */

/**
 * Whether `op`, queued for the series a create was split from, holds that
 * create back: the cut, or a series change that replaced it (an update
 * that drops exceptions), or a series delete that replaced it.
 */
export const holdsSplit = (op: PendingOp): boolean =>
  op.kind === 'delete' || (op.kind === 'update' && op.dropsFrom !== undefined);

/**
 * Whether the master's rule draws an occurrence that starts at `from` or
 * later. A master without a rule draws nothing, and neither does a deleted
 * one; a rule that cannot be read is taken to draw on.
 */
export const drawsFrom = (master: EventRecord, from: number): boolean => {
  if (master.status === 'cancelled' || !master.recurrence?.length) {
    return false;
  }
  const rule = recurrenceMasterOf(master);
  try {
    const end = recurrenceEndUtc(rule);
    // A millisecond either side: the expansion keeps what overlaps the
    // range, and an occurrence with no duration at either end overlaps
    // nothing.
    return (
      end === undefined ||
      (end >= from &&
        expandRecurringEvent(rule, from - 1, end + 1).some(
          (instance) => instance.originalStartUtc >= from,
        ))
    );
  } catch {
    return true;
  }
};

/** An occurrence's id is the master's, `_` and its original start. */
const inSeries = (masterId: string, eventId: string) =>
  eventId === masterId ||
  (eventId.startsWith(`${masterId}_`) && /\d/.test(eventId.charAt(masterId.length + 1)));

/**
 * The series' unsent creates split off `change`'s series once `change`
 * (a cut, or a series delete that replaced one) leaves the queue. Held by
 * another such change of a series with that id (another calendar's copy),
 * they wait for that one. Where `series` (as Google has it; null: not
 * there) still draws from where one starts, it goes, with everything
 * queued for it — edits of its occurrences, the series split off it — and
 * its rows. The others are due at once: they waited out a backoff that
 * grew while the cut waited.
 */
const settleSplits = (
  { eventRepo, pendingOpRepo }: TakenDeps,
  change: PendingOp,
  series: EventRecord | null,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    const { accountId, eventId: masterId } = change;
    const queued = (yield* pendingOpRepo.listAll()).filter((op) => op.accountId === accountId);
    if (queued.some((op) => op.id !== change.id && op.eventId === masterId && holdsSplit(op))) {
      return;
    }
    for (const create of queued) {
      if (
        create.kind !== 'create' ||
        create.splitOf !== masterId ||
        create.splitAt === undefined ||
        create.dispatchedAt !== undefined
      ) {
        continue;
      }
      if (!series || !drawsFrom(series, create.splitAt)) {
        yield* pendingOpRepo.makeDue(create.id);
        continue;
      }
      const { calendarId, eventId } = create;
      for (const op of queued) {
        if (op.calendarId === calendarId && inSeries(eventId, op.eventId)) {
          yield* pendingOpRepo.remove(op.id);
        }
      }
      for (const override of yield* eventRepo.listOverrides(accountId, calendarId, eventId)) {
        yield* eventRepo.deleteEvent(accountId, calendarId, override.id);
      }
      yield* eventRepo.deleteEvent(accountId, calendarId, eventId);
    }
  });

/**
 * The cut of a series was undone (a discard, keep-theirs or a rejection
 * for good of its update, or of a series delete that replaced it): the
 * series is back as Google has it — `series`, else its row now. The series
 * split off it whose creates are still unsent go with it where it draws
 * from where they start: what they show, it shows again. One Google ended
 * before (another device cut it too, or the cut landed and its answer was
 * lost) shows nothing twice, and stays.
 */
export const dropSplitSeries = (
  deps: TakenDeps,
  change: PendingOp,
  series?: EventRecord | null,
): Effect.Effect<void, SqlError> =>
  Effect.flatMap(
    series === undefined
      ? deps.eventRepo.getById(change.accountId, change.calendarId, change.eventId)
      : Effect.succeed(series),
    (master) => settleSplits(deps, change, master),
  );

/** `change` is done on Google (it landed, or found the series gone): its splits go out. */
export const releaseSplits = (deps: TakenDeps, change: PendingOp): Effect.Effect<void, SqlError> =>
  settleSplits(deps, change, null);

/** The unsent creates split off the series `change` holds back (`holdsSplit`). */
export const waitingSplits = (
  pendingOpRepo: TakenDeps['pendingOpRepo'],
  change: PendingOp,
): Effect.Effect<boolean, SqlError> =>
  Effect.map(pendingOpRepo.listAll(), (queued) =>
    holdsSplit(change)
      ? queued.some(
          (op) =>
            op.kind === 'create' &&
            op.accountId === change.accountId &&
            op.splitOf === change.eventId &&
            op.dispatchedAt === undefined,
        )
      : false,
  );
