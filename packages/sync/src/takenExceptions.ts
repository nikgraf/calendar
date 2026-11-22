import {
  EventRecord,
  expandRecurringEvent,
  type PendingOp,
  recurrenceMasterOf,
} from '@calendar/core';
import type { EventRepoShape, PendingOpRepoShape } from '@calendar/db';
import { Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import { withAnswers } from './heldEvents.ts';

/**
 * A change of a series that takes exceptions off the table holds Google's
 * copy of each (`beforeOverrides`, read from `event_copies`): they queue
 * no op of their own, since Google cancels them with the series' own
 * write. A series delete takes them all: while it waits with the master
 * gone locally, what Google sends or acknowledges for one becomes that
 * copy, and a discard puts them back with the master. An update that
 * redraws the series (a this-and-following cut, a new rule, new times)
 * takes the ones it no longer draws: given up, they come back where
 * Google's series draws them; landed, they are gone on Google too.
 * Without its master an exception row would show as an event of its own,
 * and a master without its exceptions shows a moved occurrence at its
 * slot and a cancelled one again.
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
 * Writes taken exceptions back where no row is: a row there is newer (the
 * user's occurrence edit or delete since — a landed occurrence delete
 * leaves its tombstone, Google's then). What goes back is Google's copy
 * of each. An answer still waiting for one survived the series delete and
 * shows over it, pending. Not while a delete of it waits too (a
 * this-and-following cut's): a delete owns no row, so the copy is
 * Google's, synced (`isPulledCopy`), which an answer's ack settles and
 * that delete takes when it lands — pending, nothing would ever settle it.
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
      const copy = new EventRecord({ ...override, calendarId, syncStatus: 'synced' });
      if (owners.length === 0 || owners.some((owner) => owner.kind === 'delete')) {
        yield* eventRepo.upsertMany([copy]);
        continue;
      }
      const shown = owners
        .filter((owner) => owner.kind === 'rsvp')
        .reduce((row, answer) => withAnswers(row, answer, copy), copy);
      yield* eventRepo.upsertMany([new EventRecord({ ...shown, syncStatus: 'pending' })]);
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

/**
 * Whether the master's rule draws the slot `copy` takes over. A rule that
 * does not expand draws nothing, and neither does a master without one.
 */
export const drawsSlot = (master: EventRecord, copy: EventRecord): boolean => {
  const slot = copy.originalStartUtc;
  if (slot === undefined || !master.recurrence?.length) {
    return false;
  }
  try {
    return expandRecurringEvent(recurrenceMasterOf(master), slot - 1, slot + 1).some(
      (instance) => instance.originalStartUtc === slot,
    );
  } catch {
    return false;
  }
};

/**
 * A change of a series that had dropped exceptions was given up (a
 * discard, a rejection for good, keep-theirs) and the series is on the
 * table as Google has it: the exceptions `op` held come back where that
 * series draws their slots (`putBack`: synced, a row there is newer).
 * Past the end of a cut that reached Google, one would show on its own.
 */
export const restoreDropped = (deps: TakenDeps, op: PendingOp): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    if (op.kind !== 'update' || !op.beforeOverrides?.length) {
      return;
    }
    const master = yield* deps.eventRepo.getById(op.accountId, op.calendarId, op.eventId);
    if (!master || master.status === 'cancelled') {
      return;
    }
    yield* putBack(
      deps,
      op.accountId,
      op.calendarId,
      op.beforeOverrides.filter((copy) => drawsSlot(master, copy)),
    );
  });

/**
 * A new edit of the series (`master`, as it will go to Google) draws
 * slots again that the queued update it takes over from (`queued`) had
 * dropped: Google keeps an exception whose slot the series it gets still
 * draws, so those come back as Google's copies (`putBack`, synced).
 * Returns the ones the new edit still holds.
 */
export const takeBackDropped = (
  deps: TakenDeps,
  master: EventRecord,
  queued: PendingOp | undefined,
): Effect.Effect<ReadonlyArray<EventRecord>, SqlError> =>
  Effect.gen(function* () {
    const held = queued?.kind === 'update' ? (queued.beforeOverrides ?? []) : [];
    const back = held.filter((copy) => drawsSlot(master, copy));
    if (queued && back.length > 0) {
      yield* putBack(deps, master.accountId, master.calendarId, back);
      // On the table again, they are no change's to hold.
      yield* deps.pendingOpRepo.setBeforeOverrides(
        queued.id,
        held.filter((copy) => !back.includes(copy)),
      );
    }
    return held.filter((copy) => !back.includes(copy));
  });

/**
 * A series update that drops exceptions on Google landed (`dropsFrom`: a
 * cut's occurrence, 0 for a new rule or new times; `landed`: the master
 * it sent). From that original start on, Google cancelled every exception
 * whose slot the landed series no longer draws and kept the others as
 * they were (verified live). What still holds a cancelled one is Google's
 * no more: its copy goes, so a queued op of it has nothing to put back
 * and a waiting change of the series holds it no more; a synced row
 * (Google's copy a discard put back, a landed delete's tombstone) goes;
 * and a delete of one the user made goes with nothing left to do (it owns
 * its pending tombstone, which Google's copy now is; the PATCH gave the
 * exception a new etag, so its If-Match would meet a 412 and park) unless
 * a later update queued (`landedId` is the one that landed) draws the
 * slot again: then it was made under that rule and still has work to do.
 * Until the update lands they are Google's, and giving it up brings them
 * back (`restoreDropped`). A pending row is a queued op's.
 */
export const forgetDropped = (
  { eventRepo, pendingOpRepo }: TakenDeps,
  accountId: string,
  calendarId: string,
  masterId: string,
  landed: EventRecord,
  from: number,
  landedId: string,
): Effect.Effect<void, SqlError> => {
  const dropped = (record: EventRecord | null | undefined) =>
    record?.recurringEventId === masterId &&
    (record.originalStartUtc ?? record.startUtc) >= from &&
    !drawsSlot(landed, record);
  return Effect.gen(function* () {
    const later = (yield* pendingOpRepo.listForEvent({
      accountId,
      calendarId,
      eventId: masterId,
    })).flatMap((op) =>
      op.kind === 'update' && op.id !== landedId && op.payload ? [op.payload] : [],
    );
    for (const op of yield* pendingOpRepo.listAll()) {
      if (op.accountId !== accountId || op.calendarId !== calendarId) {
        continue;
      }
      // An occurrence delete the user made owns its pending tombstone:
      // before the change, Google's cancellation did its work; under a
      // later rule that draws the slot again, it still has work to do.
      if (op.kind === 'delete' && op.eventId !== masterId && dropped(op.payload)) {
        const payload = op.payload!;
        const row = yield* eventRepo.getById(accountId, calendarId, op.eventId);
        if (row?.syncStatus !== 'pending') {
          yield* pendingOpRepo.remove(op.id);
          continue;
        }
        if (!later.some((master) => drawsSlot(master, payload))) {
          yield* pendingOpRepo.remove(op.id);
          yield* eventRepo.markSynced(accountId, calendarId, op.eventId);
          continue;
        }
      }
      if (dropped(op.beforePayload)) {
        yield* pendingOpRepo.setBefore(op.id, null);
      }
      if (op.eventId === masterId && op.beforeOverrides?.some(dropped)) {
        yield* pendingOpRepo.setBeforeOverrides(
          op.id,
          op.beforeOverrides.filter((override) => !dropped(override)),
        );
      }
    }
    for (const override of yield* eventRepo.listOverrides(accountId, calendarId, masterId)) {
      if (override.syncStatus === 'synced' && dropped(override)) {
        yield* eventRepo.deleteEvent(accountId, calendarId, override.id);
      }
    }
  });
};

/** `overrides` with `copies` in place of what it held at their ids. */
const withCopies = (
  overrides: ReadonlyArray<EventRecord> | undefined,
  copies: ReadonlyArray<EventRecord>,
): ReadonlyArray<EventRecord> => {
  const latest = new Map(copies.map((copy) => [copy.id, copy]));
  return [...(overrides ?? []).filter((override) => !latest.has(override.id)), ...latest.values()];
};

/**
 * Google sent or acknowledged an exception of a series whose delete
 * waits with the master gone locally: it becomes the copy that delete
 * holds of the exception, not a row. A discard puts it back as Google
 * has it now, a landing leaves nothing behind. Whether it went there.
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
    yield* pendingOpRepo.setBeforeOverrides(remove.id, withCopies(remove.beforeOverrides, [copy]));
    return true;
  });

/**
 * Google's live copy of an exception, for a delete of that occurrence
 * that waits too: the copy that delete reads, and puts back on a discard.
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
 * A pull page against the changes of series waiting in its calendar. An
 * exception whose series delete waits with the master gone locally (in
 * the page or not: a pull writes no row for a master whose delete waits)
 * goes into that delete where no row is (as `takeIntoDelete`, with one
 * write per series). One that a queued update of its series drops
 * (`dropsFrom`: a cut's, a new rule's, new times') goes into that update
 * the same way: the update took it off the table, where it showed past
 * the cut on its own, or over the new rule; given up, the update puts it
 * back as Google has it now (`restoreDropped`), and its landing forgets
 * it (`forgetDropped`). A row at its id takes the page as any row does
 * (`heldEvents.receive` next: one a queued op holds takes it into its
 * copy). The records left for that.
 */
export const holdPulledExceptions = (
  deps: TakenDeps,
  accountId: string,
  calendarId: string,
  upserts: ReadonlyArray<EventRecord>,
): Effect.Effect<ReadonlyArray<EventRecord>, SqlError> =>
  Effect.gen(function* () {
    // Per series: the queued change that holds its exceptions off the
    // table, if one does — its delete while the master is gone locally,
    // else an update that drops exceptions.
    const holders = new Map<string, { readonly drops?: PendingOp; readonly gone?: PendingOp }>();
    const holderOf = (masterId: string) =>
      Effect.gen(function* () {
        const known = holders.get(masterId);
        if (known) {
          return known;
        }
        const queued = yield* deps.pendingOpRepo.listForEvent({
          accountId,
          calendarId,
          eventId: masterId,
        });
        const remove = queued.find((op) => op.kind === 'delete');
        const gone =
          remove && !(yield* deps.eventRepo.getById(accountId, calendarId, masterId))
            ? remove
            : undefined;
        const drops = queued.find((op) => op.kind === 'update' && op.dropsFrom !== undefined);
        const holder = { ...(drops ? { drops } : {}), ...(gone ? { gone } : {}) };
        holders.set(masterId, holder);
        return holder;
      });
    const held = new Map<string, { readonly by: PendingOp; readonly copies: Array<EventRecord> }>();
    const hold = (by: PendingOp, record: EventRecord) => {
      const entry = held.get(by.id) ?? { by, copies: [] };
      entry.copies.push(record);
      held.set(by.id, entry);
    };
    const kept: Array<EventRecord> = [];
    for (const record of upserts) {
      const masterId = record.recurringEventId;
      if (
        masterId === undefined ||
        (yield* deps.eventRepo.getById(accountId, calendarId, record.id))
      ) {
        kept.push(record);
        continue;
      }
      const { drops, gone } = yield* holderOf(masterId);
      if (gone) {
        hold(gone, record);
      } else if (
        drops?.payload &&
        drops.dropsFrom !== undefined &&
        (record.originalStartUtc ?? record.startUtc) >= drops.dropsFrom &&
        !drawsSlot(drops.payload, record)
      ) {
        hold(drops, record);
      } else {
        kept.push(record);
      }
    }
    // One write per series: a full pass can page many exceptions of one
    // before its master.
    for (const { by, copies } of held.values()) {
      yield* deps.pendingOpRepo.setBeforeOverrides(by.id, withCopies(by.beforeOverrides, copies));
      for (const copy of copies) {
        yield* handToOwnDeletes(deps.pendingOpRepo, copy);
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
 * would — also when only deletes of its occurrences wait: a discard of
 * one would write the exception back without its master.
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
    const deletes = yield* deps.pendingOpRepo.listDeletes(accountId, calendarId);
    // An occurrence's delete names its series in what it deleted (its
    // tombstone, or the exception it took) and in Google's copy of that.
    const goneSeries = new Set(
      deletes.flatMap((remove) =>
        [
          remove.eventId,
          remove.beforePayload?.recurringEventId,
          remove.payload?.recurringEventId,
        ].filter((id): id is string => id !== undefined && deleted.has(id)),
      ),
    );
    for (const masterId of goneSeries) {
      yield* dropSeriesExceptions(deps, accountId, calendarId, masterId);
    }
    for (const remove of deletes) {
      if (deleted.has(remove.eventId) || !remove.beforeOverrides || !written.has(remove.eventId)) {
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
 * Keep-mine on a parked delete: rows of Google's still on the table at
 * its id go again, as copies the delete holds, for a discard to put back
 * as Google has them — the master's, and its exceptions' (a synced one
 * is Google's copy; one pending for an answer only goes too, the answer's
 * op holding Google's copy of it already).
 * A pending row an occurrence change made since owns is the user's own
 * and stays. The delete takes them when it lands. An occurrence's copy
 * whose slot the master on the table draws (under a series that is
 * Google's again) leaves the delete's own tombstone, pending
 * as an occurrence delete leaves one: gone, the slot showed until a pull;
 * Google's own tombstone there stays as it is.
 */
export const takeBackPulled = (
  { eventRepo, pendingOpRepo }: TakenDeps,
  op: PendingOp,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    const { accountId, calendarId, eventId } = op;
    const row = yield* eventRepo.getById(accountId, calendarId, eventId);
    if (row && row.syncStatus !== 'pending') {
      const master =
        row.recurringEventId === undefined
          ? null
          : yield* eventRepo.getById(accountId, calendarId, row.recurringEventId);
      const drawn = master !== null && drawsSlot(master, row);
      if (row.status !== 'cancelled') {
        yield* pendingOpRepo.setBefore(op.id, row);
        yield* drawn
          ? eventRepo.upsertMany([
              new EventRecord({ ...row, status: 'cancelled', syncStatus: 'pending' }),
            ])
          : eventRepo.deleteEvent(accountId, calendarId, eventId);
      } else if (!drawn) {
        yield* eventRepo.deleteEvent(accountId, calendarId, eventId);
      }
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
      // A synced row is Google's copy of the exception. A pending one
      // shows an answer that waits: its op holds Google's copy already.
      if (override.syncStatus === 'synced') {
        yield* handToOwnDeletes(pendingOpRepo, override);
        taken = withCopies(taken, [override]);
      }
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
