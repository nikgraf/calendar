import { EventRecord, type PendingOp } from '@calendar/core';
import type { EventRepoShape, PendingOpRepoShape } from '@calendar/db';
import { Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';

/**
 * A series delete takes the series' exceptions off the table and keeps
 * them in its snapshot (`beforeOverrides`: they queue no op of their
 * own). While it waits, Google's copies of them live in one place: in
 * that snapshot while the master is gone locally, where a discard puts
 * them back; in the table once a pull put Google's master back, as
 * Google's copies the delete owns no more than that master. Without its
 * master an exception row would show as an event of its own, and a
 * master without its exceptions shows a moved occurrence at its slot and
 * a cancelled one again.
 */
export interface TakenDeps {
  readonly eventRepo: EventRepoShape;
  readonly pendingOpRepo: PendingOpRepoShape;
}

/** The queued deletes of a series: the ones that took its exceptions. */
const seriesDeletes = (
  pendingOpRepo: PendingOpRepoShape,
  accountId: string,
  calendarId: string,
  masterId: string,
) =>
  Effect.map(pendingOpRepo.listForEvent({ accountId, calendarId, eventId: masterId }), (queued) =>
    queued.filter((op) => op.kind === 'delete'),
  );

/** The exceptions a queued delete of the series took locally, as Google has them. */
export const takenExceptions = (
  pendingOpRepo: PendingOpRepoShape,
  accountId: string,
  calendarId: string,
  masterId: string,
): Effect.Effect<ReadonlyArray<EventRecord>, SqlError> =>
  Effect.map(seriesDeletes(pendingOpRepo, accountId, calendarId, masterId), (deletes) =>
    deletes.flatMap((op) =>
      (op.beforeOverrides ?? []).map((override) => new EventRecord({ ...override, calendarId })),
    ),
  );

/**
 * Writes taken exceptions back where no row is: a row there is newer (a
 * pull's copy, or the user's occurrence edit or delete since — a landed
 * occurrence delete leaves its tombstone pending). One stays pending while
 * an op of the occurrence owns it: an answer survives a series delete.
 * Not while a delete of it waits too (a this-and-following cut's): a
 * delete owns no row, so the copy is Google's, synced (`isPulledCopy`),
 * which an answer's ack settles and that delete takes when it lands —
 * pending, nothing would ever settle it.
 */
export const putBack = (
  { eventRepo, pendingOpRepo }: TakenDeps,
  accountId: string,
  calendarId: string,
  overrides: ReadonlyArray<EventRecord>,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    for (const override of overrides) {
      if (yield* eventRepo.getById(accountId, calendarId, override.id)) {
        continue;
      }
      const owners = yield* pendingOpRepo.listForEvent({
        accountId,
        calendarId,
        eventId: override.id,
      });
      yield* eventRepo.upsertMany([
        new EventRecord({
          ...override,
          calendarId,
          syncStatus:
            owners.length > 0 && owners.every((owner) => owner.kind !== 'delete')
              ? 'pending'
              : 'synced',
        }),
      ]);
    }
  });

/** Puts back what the queued deletes of the series took (`putBack`); they stay queued. */
export const restoreTaken = (
  deps: TakenDeps,
  accountId: string,
  calendarId: string,
  masterId: string,
): Effect.Effect<void, SqlError> =>
  Effect.flatMap(takenExceptions(deps.pendingOpRepo, accountId, calendarId, masterId), (taken) =>
    putBack(deps, accountId, calendarId, taken),
  );

/** `overrides` with `copy` in place of what it held at that id. */
const withCopy = (
  overrides: ReadonlyArray<EventRecord> | undefined,
  copy: EventRecord,
): ReadonlyArray<EventRecord> => [
  ...(overrides ?? []).filter((override) => override.id !== copy.id),
  copy,
];

/**
 * Google sent or acknowledged an exception of a series whose delete
 * waits with the master gone locally: the copy goes into that delete's
 * snapshot, in place of what it took there, not onto the table. A
 * discard puts it back as Google has it now, a landing leaves nothing
 * behind. Whether it went there.
 */
export const takeIntoDelete = (
  { eventRepo, pendingOpRepo }: TakenDeps,
  copy: EventRecord,
): Effect.Effect<boolean, SqlError> =>
  Effect.gen(function* () {
    const masterId = copy.recurringEventId;
    if (masterId === undefined) {
      return false;
    }
    if (yield* eventRepo.getById(copy.accountId, copy.calendarId, masterId)) {
      return false;
    }
    const [remove] = yield* seriesDeletes(pendingOpRepo, copy.accountId, copy.calendarId, masterId);
    if (!remove) {
      return false;
    }
    yield* pendingOpRepo.setBeforeOverrides(remove.id, withCopy(remove.beforeOverrides, copy));
    return true;
  });

/**
 * An abandoned change of an exception a waiting series delete took (an
 * answer survives the delete) finds no row to put back: it comes out of
 * what the delete would put back instead (`revise`).
 */
export const reviseTaken = (
  { pendingOpRepo }: TakenDeps,
  exception: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly id: string;
    readonly masterId: string;
  },
  revise: (taken: EventRecord) => EventRecord,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    const { accountId, calendarId, id, masterId } = exception;
    for (const remove of yield* seriesDeletes(pendingOpRepo, accountId, calendarId, masterId)) {
      const overrides = remove.beforeOverrides;
      if (overrides?.some((override) => override.id === id)) {
        yield* pendingOpRepo.setBeforeOverrides(
          remove.id,
          overrides.map((override) => (override.id === id ? revise(override) : override)),
        );
      }
    }
  });

/**
 * Google's live copy of an exception leaves the table for a series
 * delete's snapshot: the exception's own queued delete (a cut's), which
 * left that copy on the table as Google's (`isPulledCopy`), puts it back
 * too — its older snapshot would otherwise take the row's place on a
 * discard.
 */
const handToOwnDeletes = (pendingOpRepo: PendingOpRepoShape, copy: EventRecord) =>
  Effect.gen(function* () {
    if (copy.status === 'cancelled') {
      return;
    }
    const own = yield* pendingOpRepo.listForEvent({
      accountId: copy.accountId,
      calendarId: copy.calendarId,
      eventId: copy.id,
    });
    for (const remove of own.filter((op) => op.kind === 'delete')) {
      yield* pendingOpRepo.setBefore(remove.id, copy);
    }
  });

/**
 * A pull page against the series deletes waiting in its calendar: an
 * exception whose master is gone locally, and not in the page either,
 * goes into its delete (`takeIntoDelete`) where no row is, and is what
 * the exception's own queued delete (a cut's) puts back too, as
 * `rememberPulled` hands it at a tombstone. A row at its id takes the page
 * as any row does: a synced one is overwritten, a pending one skipped
 * (`rememberPulled` sees it). The rows the table takes.
 */
export const holdPulledExceptions = (
  deps: TakenDeps,
  accountId: string,
  calendarId: string,
  upserts: ReadonlyArray<EventRecord>,
): Effect.Effect<ReadonlyArray<EventRecord>, SqlError> =>
  Effect.gen(function* () {
    const waiting = new Set(
      (yield* deps.pendingOpRepo.listDeletes(accountId, calendarId)).map((op) => op.eventId),
    );
    if (waiting.size === 0) {
      return upserts;
    }
    const inPage = new Set(upserts.map((record) => record.id));
    const kept: Array<EventRecord> = [];
    for (const record of upserts) {
      const masterId = record.recurringEventId;
      const held =
        masterId !== undefined &&
        waiting.has(masterId) &&
        !inPage.has(masterId) &&
        !(yield* deps.eventRepo.getById(accountId, calendarId, record.id)) &&
        (yield* takeIntoDelete(deps, record));
      if (held) {
        yield* handToOwnDeletes(deps.pendingOpRepo, record);
      } else {
        kept.push(record);
      }
    }
    return kept;
  });

/**
 * After a pull page, the series deletes waiting in its calendar. A master
 * the page put back at one's id (Google's copy, synced and live —
 * `isPulledCopy`) brings back what that delete took (`putBack`), and the
 * delete holds them no more: the pull that re-sent the master need not
 * have re-sent its exceptions, as the sync token sends only what changed.
 * A series the page reports deleted takes the exceptions put back with
 * its master along (`dropSeriesExceptions`), as the delete's landing
 * would.
 */
export const settlePulledSeries = (
  deps: TakenDeps,
  accountId: string,
  calendarId: string,
  page: { readonly deletions: ReadonlyArray<string>; readonly written: ReadonlyArray<EventRecord> },
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    const written = new Set(page.written.map((record) => record.id));
    const deleted = new Set(page.deletions);
    for (const remove of yield* deps.pendingOpRepo.listDeletes(accountId, calendarId)) {
      if (deleted.has(remove.eventId)) {
        yield* dropSeriesExceptions(deps, accountId, calendarId, remove.eventId);
        continue;
      }
      if (!remove.beforeOverrides || !written.has(remove.eventId)) {
        continue;
      }
      const row = yield* deps.eventRepo.getById(accountId, calendarId, remove.eventId);
      if (row?.syncStatus !== 'synced' || row.status === 'cancelled') {
        continue;
      }
      yield* putBack(deps, accountId, calendarId, remove.beforeOverrides);
      yield* deps.pendingOpRepo.setBeforeOverrides(remove.id, undefined);
    }
  });

/**
 * Keep-mine on a parked delete: Google's copies a pull put back go again,
 * into the delete's snapshot, for a discard to put back as Google has
 * them — the master's, and its exceptions' (synced, or pending for an
 * answer only: it survives a series delete, as when the delete was made).
 * A pending row an occurrence change made since owns is the user's own
 * and stays. The delete takes them when it lands.
 */
export const takeBackPulled = (
  { eventRepo, pendingOpRepo }: TakenDeps,
  op: PendingOp,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    const { accountId, calendarId, eventId } = op;
    const row = yield* eventRepo.getById(accountId, calendarId, eventId);
    if (row && row.syncStatus !== 'pending') {
      if (row.status !== 'cancelled') {
        yield* pendingOpRepo.setBefore(op.id, row);
      }
      yield* eventRepo.deleteEvent(accountId, calendarId, eventId);
    }
    let taken = op.beforeOverrides;
    for (const override of yield* eventRepo.listOverrides(accountId, calendarId, eventId)) {
      const owners = yield* pendingOpRepo.listForEvent({
        accountId,
        calendarId,
        eventId: override.id,
      });
      if (override.syncStatus !== 'synced' && owners.some((owner) => owner.kind !== 'rsvp')) {
        continue;
      }
      if (override.syncStatus === 'synced') {
        yield* handToOwnDeletes(pendingOpRepo, override);
      }
      taken = withCopy(taken, override);
      yield* eventRepo.deleteEvent(accountId, calendarId, override.id);
    }
    if (taken !== op.beforeOverrides) {
      yield* pendingOpRepo.setBeforeOverrides(op.id, taken);
    }
  });

/**
 * The series is gone on Google (its delete landed, or Google deleted it):
 * its exceptions went with it. The synced rows a pull, an answer or a
 * discard put back go too, or they would show as events of their own;
 * a pending one belongs to a queued op, which meets the 404 itself and
 * has nothing left to put back (`forgetSeries`).
 */
export const dropSeriesExceptions = (
  { eventRepo, pendingOpRepo }: TakenDeps,
  accountId: string,
  calendarId: string,
  masterId: string,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    for (const override of yield* eventRepo.listOverrides(accountId, calendarId, masterId)) {
      if (override.syncStatus === 'synced') {
        yield* eventRepo.deleteEvent(accountId, calendarId, override.id);
      }
    }
    yield* pendingOpRepo.forgetSeries(accountId, calendarId, masterId);
  });
