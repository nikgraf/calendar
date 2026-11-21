import { Attendee, EventRecord, type PendingOp, withConsistentGeo } from '@calendar/core';
import type { EventRepoShape, PendingOpRepoShape } from '@calendar/db';
import { toGcalAttendees } from '@calendar/google';
import { Clock, Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';

/**
 * Held events. While a change of an event waits in the queue, the event's
 * row shows the user's version and Google's copy lives beside it, once per
 * event (`event_copies`, which every queued op of the event reads as its
 * `beforePayload`). A pull, or the fetch after a refused write, brings
 * Google's newer version: it becomes the copy, and the queued changes are
 * laid over it again (`rebaseOnto`) — what the user changed stays, what
 * another device changed elsewhere in the event shows too, and nobody is
 * asked. Only when both changed the same thing does the change wait for
 * the user's choice.
 */

/** Row bookkeeping no edit changes: left out when looking for what a version changed. */
const ROW_BOOKKEEPING: ReadonlySet<string> = new Set([
  'accountId',
  'calendarId',
  'etag',
  'id',
  'mirror',
  'syncStatus',
  'syncedAt',
  'updatedAt',
]);

/**
 * The fields in which `payload` differs from `before`, with their values
 * in `before`: what an edit changed and what it replaced. A discard puts
 * back only these, so it cannot resurrect what another op of the event
 * changed and was discarded meanwhile.
 */
export const changedFields = (before: EventRecord, payload: EventRecord): Partial<EventRecord> => {
  const was = before as unknown as Record<string, unknown>;
  const sent = payload as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(was), ...Object.keys(sent)])) {
    if (!ROW_BOOKKEEPING.has(key) && JSON.stringify(was[key]) !== JSON.stringify(sent[key])) {
      patch[key] = was[key];
    }
  }
  return patch;
};

export const responseOf = (
  attendees: ReadonlyArray<Attendee> | undefined,
  email: string,
): Attendee['responseStatus'] | undefined =>
  attendees?.find((attendee) => attendee.email === email)?.responseStatus;

/**
 * Fields the user reads as one thing: a time is its start, its end and
 * whether it is all day; a place is its text and its coordinates. Two
 * changes inside one of these are changes of the same thing.
 */
const FIELD_GROUP: Readonly<Record<string, string>> = {
  endDate: 'time',
  endUtc: 'time',
  geo: 'place',
  isAllDay: 'time',
  location: 'place',
  startDate: 'time',
  startTimeZone: 'time',
  startUtc: 'time',
};
const groupOf = (field: string): string => FIELD_GROUP[field] ?? field;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** `base` with the answers `rsvp` changed since `old` laid over its guests. */
export const withAnswers = (
  base: EventRecord,
  rsvp: PendingOp,
  old: EventRecord | null | undefined,
): EventRecord => {
  const answered = rsvp.payload?.attendees;
  if (!answered || !base.attendees) {
    return base;
  }
  return new EventRecord({
    ...base,
    attendees: base.attendees.map((attendee) => {
      const mine = responseOf(answered, attendee.email);
      return mine === undefined || mine === responseOf(old?.attendees, attendee.email)
        ? attendee
        : new Attendee({ ...attendee, responseStatus: mine });
    }),
  });
};

/**
 * A queued update laid over Google's newer copy of its event: `old` is
 * the copy it was made on, `theirs` the one Google has now. The fields
 * the update changed keep its values, every other field takes Google's:
 * that is its payload either way. `clash` when both changed the same
 * thing to different values: then the user is asked, and what they
 * compare is that payload against Google's version — their own changes,
 * nothing a third change made elsewhere in the event. So is an update
 * that edits the guest list, whenever Google's version moved and does
 * not already hold that edit: Google replaces the whole list, guest
 * fields this app does not keep (optional, comment) included. The guest
 * list of an update that did not edit it is Google's: answers belong to
 * RSVPs.
 */
export const rebaseOnto = (
  op: PendingOp,
  old: EventRecord,
  theirs: EventRecord,
): { readonly kind: 'clash' | 'rebased'; readonly payload: EventRecord } => {
  const payload = op.payload;
  if (!payload) {
    return { kind: 'clash', payload: theirs };
  }
  const { attendees: _guestsWere, ...mine } = changedFields(old, payload);
  const editsGuests = op.attendeesChanged === true;
  const moved = Object.keys(changedFields(old, theirs));
  const mineGroups = new Set(Object.keys(mine).map(groupOf));
  const ours = payload as unknown as Record<string, unknown>;
  const now = theirs as unknown as Record<string, unknown>;
  const guestsClash =
    editsGuests &&
    !(
      same(toGcalAttendees(theirs), toGcalAttendees(payload)) &&
      Object.keys(mine).every((field) => same(now[field], ours[field]))
    );
  const clash =
    guestsClash ||
    moved.some((field) => mineGroups.has(groupOf(field)) && !same(now[field], ours[field]));
  const kept = Object.fromEntries(Object.keys(mine).map((field) => [field, ours[field]]));
  return {
    kind: clash ? 'clash' : 'rebased',
    payload: withConsistentGeo(
      new EventRecord({
        ...theirs,
        ...kept,
        ...(editsGuests ? { attendees: payload.attendees } : {}),
        syncStatus: 'pending',
        updatedAt: payload.updatedAt,
      }),
    ),
  };
};

export interface HeldEventDeps {
  readonly eventRepo: EventRepoShape;
  readonly pendingOpRepo: PendingOpRepoShape;
}

export interface HeldEvents {
  /**
   * A pull's page of one calendar: for each event a queued change holds,
   * Google's version becomes its copy and the change is laid over it
   * again, row and all (a change that clashes with it is parked for the
   * user). Returns the records nothing holds, for the caller to write.
   */
  readonly receive: (
    accountId: string,
    calendarId: string,
    records: ReadonlyArray<EventRecord>,
  ) => Effect.Effect<ReadonlyArray<EventRecord>, SqlError>;
  /**
   * Google's newer version of one event (a pull's, or the fetch after a
   * refused write): it becomes the event's copy, and every queued change
   * of the event is laid over it again, row and all. A change that
   * clashes with it is parked for the user.
   */
  readonly take: (theirs: EventRecord) => Effect.Effect<void, SqlError>;
}

/** The op kinds that hold an event Google has: the ones a newer copy concerns. */
const HOLDING: ReadonlySet<PendingOp['kind']> = new Set(['delete', 'rsvp', 'update']);

export const makeHeldEvents = (deps: HeldEventDeps): HeldEvents => {
  const { eventRepo, pendingOpRepo } = deps;

  /** Google's newer copy of one held event, taken in. */
  const takeOver = (theirs: EventRecord, ops: ReadonlyArray<PendingOp>) =>
    Effect.gen(function* () {
      const event = {
        accountId: theirs.accountId,
        calendarId: theirs.calendarId,
        eventId: theirs.id,
      };
      const holding = ops.filter((op) => HOLDING.has(op.kind));
      const old = holding[0]?.beforePayload ?? null;
      const now = yield* Clock.currentTimeMillis;
      const first = holding[0];
      if (first) {
        // The copy is Google's, whatever becomes of the changes below.
        yield* pendingOpRepo.setBefore(first.id, theirs);
      }
      // A cancelled occurrence, or an event Google had none of before (its
      // override was materialized here): nothing to lay the changes over.
      // They go as they are and meet Google's answer.
      if (theirs.status === 'cancelled' || old === null) {
        return;
      }
      let row: EventRecord | undefined = undefined;
      let removed = false;
      for (const op of holding) {
        if (op.kind === 'delete') {
          removed = true;
          // A delete of an event that changed since asks first, as the 412
          // of its If-Match would: the version it names is the one the
          // user deleted (a move of ours that landed since moved it on).
          // One the user kept (no If-Match) goes whatever Google has.
          if (
            op.conflictAt !== undefined ||
            (op.baseEtag !== undefined && theirs.etag !== op.baseEtag)
          ) {
            yield* pendingOpRepo.markConflict(op.id, op.conflictAt ?? now);
          }
          continue;
        }
        if (op.conflictAt !== undefined) {
          // Parked already: its preview of Google's version moves on, and
          // it stays the user's version on screen.
          yield* pendingOpRepo.markConflict(op.id, op.conflictAt);
          const kept = op.kind === 'rsvp' ? undefined : rebaseOnto(op, old, theirs).payload;
          if (kept) {
            row = kept;
            yield* pendingOpRepo.setPayload(op.id, kept);
          }
          continue;
        }
        if (op.kind === 'rsvp') {
          row = withAnswers(row ?? theirs, op, old);
          yield* pendingOpRepo.setPayload(op.id, row);
          continue;
        }
        const rebased = rebaseOnto(op, old, theirs);
        row = rebased.payload;
        yield* pendingOpRepo.setPayload(op.id, rebased.payload);
        if (rebased.kind === 'clash') {
          yield* pendingOpRepo.markConflict(op.id, now);
        }
      }
      if (theirs.etag !== null) {
        yield* pendingOpRepo.setBaseEtag(event, theirs.etag);
      }
      if (row !== undefined && !removed) {
        yield* eventRepo.upsertMany([new EventRecord({ ...row, syncStatus: 'pending' })]);
      }
    });

  const receive: HeldEvents['receive'] = (accountId, calendarId, records) =>
    Effect.gen(function* () {
      if (records.length === 0) {
        return records;
      }
      // Few events are held at a time: their ops are read once per page.
      const queued = new Map<string, Array<PendingOp>>();
      for (const op of yield* pendingOpRepo.listAll()) {
        if (op.accountId === accountId && op.calendarId === calendarId) {
          queued.set(op.eventId, [...(queued.get(op.eventId) ?? []), op]);
        }
      }
      const free: Array<EventRecord> = [];
      for (const record of records) {
        const ops = queued.get(record.id) ?? [];
        // A create still queued: Google's copy is that create landed, and
        // its own answer (or its 409) settles the row.
        if (!ops.some((op) => HOLDING.has(op.kind)) || ops.some((op) => op.kind === 'create')) {
          free.push(record);
          continue;
        }
        yield* takeOver(record, ops);
      }
      return free;
    });

  const take: HeldEvents['take'] = (theirs) =>
    Effect.flatMap(
      pendingOpRepo.listForEvent({
        accountId: theirs.accountId,
        calendarId: theirs.calendarId,
        eventId: theirs.id,
      }),
      (ops) => takeOver(theirs, ops),
    );

  return { receive, take };
};
