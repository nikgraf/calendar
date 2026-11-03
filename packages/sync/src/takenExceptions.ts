import {
  EventRecord,
  expandRecurringEvent,
  type PendingOp,
  recurrenceMasterOf,
} from '@calendar/core';
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
 * pending, nothing would ever settle it. Such a copy taken from the row an
 * answer made pending (the cut's snapshot) goes back with Google's
 * answers, the ones that answer replaced: kept, a discarded answer stayed
 * on Google's copy.
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
      const removing = owners.some((owner) => owner.kind === 'delete');
      const replaced =
        removing && override.syncStatus === 'pending'
          ? owners.find((owner) => owner.kind === 'rsvp')?.beforePayload
          : undefined;
      yield* eventRepo.upsertMany([
        new EventRecord({
          ...override,
          ...(replaced ? { attendees: replaced.attendees } : {}),
          calendarId,
          syncStatus: owners.length > 0 && !removing ? 'pending' : 'synced',
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

/** `putBack` of the copies the occurrences' own deletes (`deletes`) took off `master`. */
const putBackDropped = (
  deps: TakenDeps,
  master: EventRecord,
  deletes: ReadonlyArray<PendingOp>,
): Effect.Effect<void, SqlError> =>
  master.recurrence === undefined || master.recurrence.length === 0 || master.status === 'cancelled'
    ? Effect.void
    : putBack(
        deps,
        master.accountId,
        master.calendarId,
        deletes.flatMap((remove) => {
          const copy = remove.beforePayload;
          return copy?.id === remove.eventId &&
            copy.recurringEventId === master.id &&
            drawsSlot(master, copy)
            ? [copy]
            : [];
        }),
      );

/**
 * Google's master is on the table again (a discard or keep-theirs put it
 * back, or a discarded change gave it Google's rule back): the exceptions
 * that queued deletes of its occurrences took off the table — a
 * this-and-following cut's, or a rule change's, which leave no tombstone
 * — are Google's while those wait. They go back where no row is
 * (`putBack`: synced, as a delete owns no row — `isPulledCopy`), for each
 * delete to take when it lands. Off the table, a moved occurrence showed
 * at its slot, a cancelled one came back, and an edit of one was built on
 * the slot. Only where the master's rule draws the slot: past the end of a
 * cut that reached Google, one would show on its own.
 */
export const restoreDropped = (
  deps: TakenDeps,
  accountId: string,
  calendarId: string,
  masterId: string,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    const master = yield* deps.eventRepo.getById(accountId, calendarId, masterId);
    if (master?.recurrence !== undefined) {
      yield* putBackDropped(
        deps,
        master,
        yield* deps.pendingOpRepo.listDeletes(accountId, calendarId),
      );
    }
  });

/**
 * A change of the series' rule (`master`, as it will go to Google) draws
 * slots again that a cut or rule change queued before it dropped: the
 * deletes those queued for them, still waiting, go, and the exceptions they
 * hold come back as Google's copies (`putBack`, synced) — Google keeps an
 * exception whose slot the rule it gets still draws. Sent, those deletes
 * cancelled what the new rule keeps. If the earlier change reached Google
 * after all, its landing forgets the copies again (`forgetDropped`): Google
 * cancelled them, and draws the slots plain once the new rule lands. A
 * delete with its pending tombstone is an occurrence delete the user made,
 * and stays.
 */
export const takeBackDropped = (
  deps: TakenDeps,
  master: EventRecord,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    const { accountId, calendarId } = master;
    const copies: Array<EventRecord> = [];
    for (const remove of yield* deps.pendingOpRepo.listDeletes(accountId, calendarId)) {
      const slot = remove.payload;
      if (
        remove.eventId === master.id ||
        slot?.recurringEventId !== master.id ||
        !drawsSlot(master, slot) ||
        (yield* deps.eventRepo.getById(accountId, calendarId, remove.eventId))?.syncStatus ===
          'pending'
      ) {
        continue;
      }
      yield* deps.pendingOpRepo.remove(remove.id);
      if (remove.beforePayload?.id === remove.eventId) {
        copies.push(remove.beforePayload);
      }
    }
    yield* putBack(deps, accountId, calendarId, copies);
  });

/**
 * A series change that dropped exceptions was abandoned — a discard, a
 * rejection for good or keep-theirs of a cut's or a rule change's update
 * (from its `dropsFrom` on), or of a series delete that replaced one (all
 * of them) — and the series is back as Google has it: the deletes it
 * queued for those exceptions (`dropOverridesFrom`) go with it, or they
 * still deleted those occurrences on Google. Such a delete owns no row
 * (the change took its exception off the table; one there is Google's
 * copy, synced); an occurrence delete the user made owns its pending
 * tombstone and stays. Run after `restoreDropped`, which puts their copies
 * back as Google's.
 */
export const dropChangeDeletes = (
  { eventRepo, pendingOpRepo }: TakenDeps,
  accountId: string,
  calendarId: string,
  masterId: string,
  from = Number.NEGATIVE_INFINITY,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    for (const remove of yield* pendingOpRepo.listDeletes(accountId, calendarId)) {
      const exception = remove.payload;
      if (
        exception?.recurringEventId !== masterId ||
        remove.eventId !== exception.id ||
        (exception.originalStartUtc ?? exception.startUtc) < from
      ) {
        continue;
      }
      const row = yield* eventRepo.getById(accountId, calendarId, remove.eventId);
      if (row?.syncStatus !== 'pending') {
        yield* pendingOpRepo.remove(remove.id);
      }
    }
  });

/**
 * A series update that drops exceptions on Google landed (`dropsFrom`: a
 * cut's occurrence, 0 for a new rule; `landed`: the master it sent). From
 * that original start on, Google cancelled every exception whose slot the
 * landed rule no longer draws (past the cut's end, or skipped by the new
 * rule) and kept the others as they were (verified live). What still holds
 * a cancelled one is Google's no more — a queued op's snapshot (an edit
 * that replaced a cut's delete) becomes `null`, nothing to put back; a
 * waiting series delete lets it go; a synced row (a pull's copy, a landed
 * delete's tombstone) goes; and the delete the cut or rule change queued
 * for one goes with nothing left to do: the PATCH gave the exception a new
 * etag, so its If-Match would meet a 412 and park. So does one the user
 * made (it owns its pending tombstone, which Google's copy now is) unless
 * a later update queued (`landedId` is the one that landed) draws the
 * slot again: then it was made under that rule and still has work to do.
 * Put back under a later master whose rule
 * draws those slots, they showed over it. Until the update lands they are
 * Google's, and its discard brings them back (`restoreDropped`). A pending
 * row is a queued op's.
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
      // The cut's or rule change's own delete owns no row. One with its
      // pending tombstone is an occurrence delete the user made: before the
      // change, Google's cancellation did its work; under a later rule that
      // draws the slot again, it still has work to do.
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
    yield* pendingOpRepo.setBeforeOverrides(remove.id, withCopies(remove.beforeOverrides, [copy]));
    return true;
  });

/**
 * An abandoned change of an exception a waiting series delete took (an
 * answer survives the delete) finds no row to put back: it comes out of
 * what the delete would put back instead (`revise`) — where the delete
 * took the row the change made pending. A synced entry is Google's copy,
 * which never held it (`isPulledCopy`).
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
      const owned = (override: EventRecord) =>
        override.id === id && override.syncStatus === 'pending';
      if (overrides?.some(owned)) {
        yield* pendingOpRepo.setBeforeOverrides(
          remove.id,
          overrides.map((override) => (owned(override) ? revise(override) : override)),
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
 * A pull page against the deletes waiting in its calendar. An exception
 * whose series delete waits with the master gone locally, and not in the
 * page either, goes into that delete where no row is (as
 * `takeIntoDelete`, with one snapshot write per series), and is what the
 * exception's own queued delete (a cut's) puts back too, as
 * `rememberPulled` hands it at a tombstone. A live exception a queued
 * series update drops (`dropsFrom`: a cut's, a rule change's), whose own
 * delete waits, goes into that delete where no row is: the update took it
 * off the table, where it showed past the cut on its own, or over the new
 * rule; a discard of the update puts it back as Google has it now
 * (`restoreDropped`), its landing forgets it (`forgetDropped`). A row at
 * its id takes the page as any row does: a synced one is overwritten, a
 * pending one skipped (`rememberPulled` sees it). The rows the table
 * takes.
 */
export const holdPulledExceptions = (
  deps: TakenDeps,
  accountId: string,
  calendarId: string,
  upserts: ReadonlyArray<EventRecord>,
): Effect.Effect<ReadonlyArray<EventRecord>, SqlError> =>
  Effect.gen(function* () {
    // The first queued delete of each event, as `takeIntoDelete` takes a master's.
    const waiting = new Map<string, PendingOp>();
    for (const remove of yield* deps.pendingOpRepo.listDeletes(accountId, calendarId)) {
      if (!waiting.has(remove.eventId)) {
        waiting.set(remove.eventId, remove);
      }
    }
    if (waiting.size === 0) {
      return upserts;
    }
    const inPage = new Set(upserts.map((record) => record.id));
    const gone = new Map<string, boolean>();
    // The earliest original start a queued update of each master drops from.
    const dropping = new Map<string, number | undefined>();
    const held = new Map<string, Array<EventRecord>>();
    const kept: Array<EventRecord> = [];
    for (const record of upserts) {
      const masterId = record.recurringEventId;
      if (
        masterId === undefined ||
        !(waiting.has(masterId) || waiting.has(record.id)) ||
        (yield* deps.eventRepo.getById(accountId, calendarId, record.id))
      ) {
        kept.push(record);
        continue;
      }
      if (waiting.has(masterId) && !inPage.has(masterId)) {
        if (!gone.has(masterId)) {
          gone.set(masterId, !(yield* deps.eventRepo.getById(accountId, calendarId, masterId)));
        }
        if (gone.get(masterId)) {
          const copies = held.get(masterId) ?? [];
          copies.push(record);
          held.set(masterId, copies);
          continue;
        }
      }
      if (!dropping.has(masterId)) {
        const updates = (yield* deps.pendingOpRepo.listForEvent({
          accountId,
          calendarId,
          eventId: masterId,
        })).flatMap((op) =>
          op.kind === 'update' && op.dropsFrom !== undefined ? [op.dropsFrom] : [],
        );
        dropping.set(masterId, updates.length > 0 ? Math.min(...updates) : undefined);
      }
      const from = dropping.get(masterId);
      if (
        record.status !== 'cancelled' &&
        waiting.has(record.id) &&
        from !== undefined &&
        (record.originalStartUtc ?? record.startUtc) >= from
      ) {
        yield* handToOwnDeletes(deps.pendingOpRepo, record);
        continue;
      }
      kept.push(record);
    }
    // One snapshot write per series: a full pass can page many exceptions
    // of one before its master.
    for (const [masterId, copies] of held) {
      const remove = waiting.get(masterId)!;
      yield* deps.pendingOpRepo.setBeforeOverrides(
        remove.id,
        withCopies(remove.beforeOverrides, copies),
      );
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
 * would — also when only its occurrences' own deletes (a cut's) wait: a
 * discard of one would write the exception back without its master. A
 * master the page wrote as Google's brings back what those deletes took
 * (`restoreDropped`): a cut's deletes outlive a series delete, which no
 * longer finds their rows.
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
    const goneSeries = new Set(
      deletes.flatMap((remove) =>
        [remove.eventId, remove.beforePayload?.recurringEventId].filter(
          (id): id is string => id !== undefined && deleted.has(id),
        ),
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
    const masters = new Set(
      deletes.flatMap((remove) => {
        const masterId = remove.beforePayload?.recurringEventId;
        return masterId !== undefined && written.has(masterId) ? [masterId] : [];
      }),
    );
    for (const masterId of masters) {
      // Pending, the pull skipped it: the master is the user's (a cut's or
      // a rule change's), and its exceptions stay off the table.
      const master = yield* deps.eventRepo.getById(accountId, calendarId, masterId);
      if (master?.syncStatus === 'synced') {
        yield* putBackDropped(deps, master, deletes);
      }
    }
  });

/**
 * Keep-mine on a parked delete: Google's copies a pull put back go again,
 * into the delete's snapshot, for a discard to put back as Google has
 * them — the master's, and its exceptions' (synced, or pending for an
 * answer only: it survives a series delete, as when the delete was made).
 * A pending row an occurrence change made since owns is the user's own
 * and stays. The delete takes them when it lands. An occurrence's copy
 * whose slot the master on the table draws (a cut's delete under the
 * series back as Google has it) leaves the delete's own tombstone, pending
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
      if (override.syncStatus === 'synced') {
        yield* handToOwnDeletes(pendingOpRepo, override);
      }
      taken = withCopies(taken, [override]);
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
