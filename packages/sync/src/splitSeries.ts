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
 * A this-and-following edit cuts the series it edits (an update that drops
 * exceptions, or the series' unsent create, which takes the cut in) and
 * queues the create of a new series from the edited occurrence on, which
 * names where it came from (`splitOf`, `splitAt`). Google gets the two as
 * one change: the create waits for the cut (`holdsSplit`), and an undone
 * cut takes it along (`dropSplitSeries`). Either one alone showed those
 * occurrences twice on Google.
 */

/**
 * Whether `op`, queued for the series a create was split from, holds that
 * create back: the series' own create (which carries the cut), its cut or
 * a series change that replaced it (an update that drops exceptions), or a
 * series delete that replaced it.
 */
export const holdsSplit = (op: PendingOp): boolean =>
  op.kind === 'create' ||
  op.kind === 'delete' ||
  (op.kind === 'update' && op.dropsFrom !== undefined);

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
    return (
      end === undefined ||
      (end > from &&
        expandRecurringEvent(rule, from, end).some((instance) => instance.originalStartUtc >= from))
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
 * The cut of a series was undone (a discard, keep-theirs or a rejection
 * for good of its update, or of a series delete that replaced it), and the
 * series is back on the table as Google has it. The series split off it
 * whose creates are still unsent go with it, with everything queued for
 * them — edits of their occurrences, and the series split off them in
 * turn — and their rows: what they show, the series shows again. Only where
 * the series still draws from where the new one starts: one Google ended
 * before (another device cut it too, or the cut rode in its create) shows
 * nothing twice, and stays.
 */
export const dropSplitSeries = (
  { eventRepo, pendingOpRepo }: TakenDeps,
  accountId: string,
  calendarId: string,
  masterId: string,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    const master = yield* eventRepo.getById(accountId, calendarId, masterId);
    if (!master) {
      return;
    }
    const queued = (yield* pendingOpRepo.listAll()).filter((op) => op.accountId === accountId);
    const from = [masterId];
    for (let next = from.pop(); next !== undefined; next = from.pop()) {
      const splitOf = next;
      for (const create of queued) {
        if (
          create.kind !== 'create' ||
          create.splitOf !== splitOf ||
          create.splitAt === undefined ||
          create.dispatchedAt !== undefined ||
          !drawsFrom(master, create.splitAt)
        ) {
          continue;
        }
        const series = create.eventId;
        for (const op of queued) {
          if (op.calendarId === create.calendarId && inSeries(series, op.eventId)) {
            yield* pendingOpRepo.remove(op.id);
          }
        }
        for (const override of yield* eventRepo.listOverrides(
          accountId,
          create.calendarId,
          series,
        )) {
          yield* eventRepo.deleteEvent(accountId, create.calendarId, override.id);
        }
        yield* eventRepo.deleteEvent(accountId, create.calendarId, series);
        from.push(series);
      }
    }
  });
