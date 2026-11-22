import { Attendee, EventRecord, type PendingOp } from '@calendar/core';
import type { EventRepoShape, PendingOpRepoShape } from '@calendar/db';
import { toGcalAttendees } from '@calendar/google';
import { Clock, Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';

/**
 * Held events. While a change of an event waits in the queue, the event's
 * row shows the user's version and Google's copy lives beside it, once per
 * event (`event_copies`, which every queued op of the event reads as its
 * `beforePayload`). Each queued change keeps only what it set, and the
 * version it makes is Google's copy with the changes queued for the event
 * over it, in their order. A pull, or the fetch after a refused write,
 * brings Google's newer version: it becomes the copy, and so every queued
 * change is laid over it from then on — what the user changed stays, what
 * another device changed elsewhere in the event shows too, and nobody is
 * asked. Only when both changed the same thing does the change wait for
 * the user's choice (`clashes`).
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
 * Whether a queued update has to ask the user, now that what it is laid
 * over changed: `was` is that before (Google's copy with the changes
 * queued ahead of it), `now` the same with Google's newer copy, `news`
 * the fields in which the two copies themselves differ — a field counts
 * as changed on Google only when it is in both: what a series' queued
 * edit carries onto an exception is laid under its change only while
 * Google's copy is the one it was carried onto, and is no news when a
 * newer copy ends that. Its own
 * fields are the ones in which its version differs from `was` and the ones
 * it names (`changed`), also where their value is the old one. It asks
 * when both changed the same thing to different values: the user then
 * compares their version against Google's — their own changes, nothing a
 * third change made elsewhere in the event. What an earlier change of
 * ours left on Google is in both `was` and `now`, and is no news. An
 * update that edits the guest list asks whenever what it is laid over
 * moved and does not already hold that edit: Google replaces the whole
 * list, guest fields this app does not keep (optional, comment) included.
 * The guest list of an update that did not edit it is Google's: answers
 * belong to RSVPs.
 */
export const clashes = (
  op: PendingOp,
  was: EventRecord,
  now: EventRecord,
  news: ReadonlySet<string>,
): boolean => {
  const payload = op.payload;
  if (!payload) {
    return true;
  }
  const { attendees: _guestsWere, ...differing } = changedFields(was, payload);
  const mine = new Set([...Object.keys(differing), ...(op.changed ?? [])]);
  const mineGroups = new Set([...mine].map(groupOf));
  const ours = payload as unknown as Record<string, unknown>;
  const theirs = now as unknown as Record<string, unknown>;
  if (
    op.attendeesChanged === true &&
    !(
      same(toGcalAttendees(now), toGcalAttendees(payload)) &&
      [...mine].every((field) => same(theirs[field], ours[field]))
    )
  ) {
    return true;
  }
  // A thing the user changed is the user's whole: a start set here with an
  // end set there is a time nobody chose.
  return Object.keys(changedFields(was, now)).some(
    (field) =>
      news.has(field) && mineGroups.has(groupOf(field)) && !same(theirs[field], ours[field]),
  );
};

/**
 * What a parked update would make of Google's version: that version with
 * the update's own fields over it. Not also what an earlier change still
 * queued for the event set (the op's `payload` holds that too): that one
 * is not this one's to keep or to give up, and shown as "mine" it read as
 * part of the choice — which then left it queued under "theirs".
 */
export const ownVersion = (op: PendingOp): EventRecord | undefined => {
  const { basePayload, beforePayload, payload } = op;
  if (!payload || !basePayload || !beforePayload || op.kind !== 'update') {
    return payload;
  }
  const mine = payload as unknown as Record<string, unknown>;
  const own = [...Object.keys(changedFields(basePayload, payload)), ...(op.changed ?? [])].filter(
    (field) => field !== 'attendees' || op.attendeesChanged === true,
  );
  return new EventRecord({
    ...beforePayload,
    ...Object.fromEntries(own.map((field) => [field, mine[field]])),
    syncStatus: 'pending',
    updatedAt: payload.updatedAt,
  });
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
   * Writes the row of a held event again from what is queued for it:
   * Google's copy with the last waiting change over it, pending (for an
   * occurrence Google has no exception for, its series drawn at the slot).
   * After the copy moved on without a version to compare (an answer of
   * our own landed, a page brought the series anew), so the row shows what
   * the waiting changes now send. `except` is an op about to leave the
   * queue. A queued delete leaves no row.
   */
  readonly show: (
    event: { readonly accountId: string; readonly calendarId: string; readonly eventId: string },
    except?: string,
  ) => Effect.Effect<void, SqlError>;
  /**
   * Google's newer version of one event (the fetch after a refused write,
   * or the reply to a write sent without If-Match, which may hold another
   * device's change too): it becomes the event's copy, and every queued
   * change of the event is laid over it again, row and all. A change that
   * clashes with it is parked for the user. `except` is the op whose
   * reply this is, still queued: its change is in `theirs`.
   */
  readonly take: (theirs: EventRecord, except?: string) => Effect.Effect<void, SqlError>;
}

/** The op kinds that hold an event Google has: the ones a newer copy concerns. */
const HOLDING: ReadonlySet<PendingOp['kind']> = new Set(['delete', 'rsvp', 'update']);

export const makeHeldEvents = (deps: HeldEventDeps): HeldEvents => {
  const { eventRepo, pendingOpRepo } = deps;

  const show: HeldEvents['show'] = (event, except) =>
    Effect.gen(function* () {
      const ops = yield* pendingOpRepo.listForEvent(event, except);
      const last = ops.findLast((op) => (op.kind === 'rsvp' || op.kind === 'update') && op.payload);
      if (!last?.payload || !last.basePayload || ops.some((op) => op.kind === 'delete')) {
        return;
      }
      if (yield* eventRepo.getById(event.accountId, event.calendarId, event.eventId)) {
        yield* eventRepo.upsertMany([new EventRecord({ ...last.payload, syncStatus: 'pending' })]);
      }
    });

  /**
   * Google's newer copy of one held event, taken in. `except` is an op
   * whose reply `theirs` is: still queued, and its change in `theirs`.
   */
  const takeOver = (theirs: EventRecord, ops: ReadonlyArray<PendingOp>, except?: string) =>
    Effect.gen(function* () {
      const event = {
        accountId: theirs.accountId,
        calendarId: theirs.calendarId,
        eventId: theirs.id,
      };
      const holding = ops.filter((op) => HOLDING.has(op.kind));
      // What the changes were made on: Google's copy, or for an occurrence
      // Google had no exception for, its series drawn at the slot. An
      // exception another device made of it since is then news like any
      // other: what it changed elsewhere shows, and the same thing asks.
      const old = holding[0]?.beforePayload ?? holding[0]?.basePayload ?? null;
      const now = yield* Clock.currentTimeMillis;
      const first = holding[0];
      if (first) {
        // The copy is Google's, whatever becomes of the changes below.
        yield* pendingOpRepo.setBefore(first.id, theirs);
      }
      // A cancelled occurrence, or an event neither Google nor a series
      // here had before: nothing to lay the changes over. They go as they
      // are and meet Google's answer.
      if (theirs.status === 'cancelled' || old === null) {
        return;
      }
      // The changes themselves stay as they are queued: each is its own
      // fields, and the version it makes is `theirs` with those over it
      // from here on. What is left to decide is who has to be asked: each
      // by what it was laid over then and is laid over now.
      const laidOver = new Map(
        (yield* pendingOpRepo.listForEvent(event, except)).map((op) => [op.id, op.basePayload]),
      );
      const news = new Set(Object.keys(changedFields(old, theirs)));
      for (const op of holding) {
        if (op.kind === 'delete') {
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
          continue;
        }
        if (op.kind === 'rsvp') {
          continue;
        }
        // Made on this very version: a full list names every event,
        // changed or not, and a page can bring a version again. Nothing
        // moved under the edit to lay it over anew (a guest-list edit,
        // which differs from Google's list by its nature, parked on it).
        // One sent without If-Match (the user kept it) was made on the
        // copy: the version they compared against is no news either.
        if (theirs.etag !== null && (op.baseEtag ?? old.etag) === theirs.etag && op.payload) {
          continue;
        }
        if (clashes(op, op.basePayload ?? old, laidOver.get(op.id) ?? theirs, news)) {
          yield* pendingOpRepo.markConflict(op.id, now);
        }
      }
      if (theirs.etag !== null) {
        yield* pendingOpRepo.setBaseEtag(event, theirs.etag);
      }
      yield* show(event, except);
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
        // its own answer (or the engine, with this record) settles the row.
        // Deleted here since: no row is written, and the record is the
        // copy that delete holds.
        const create = ops.find((op) => op.kind === 'create');
        if (create && ops.some((op) => op.kind === 'delete')) {
          yield* pendingOpRepo.advanceBefore(
            { accountId, calendarId, eventId: record.id },
            record,
            create,
          );
          continue;
        }
        if (create || !ops.some((op) => HOLDING.has(op.kind))) {
          free.push(record);
          continue;
        }
        yield* takeOver(record, ops);
      }
      return free;
    });

  const take: HeldEvents['take'] = (theirs, except) =>
    Effect.flatMap(
      pendingOpRepo.listForEvent({
        accountId: theirs.accountId,
        calendarId: theirs.calendarId,
        eventId: theirs.id,
      }),
      (ops) =>
        takeOver(
          theirs,
          ops.filter((op) => op.id !== except),
          except,
        ),
    );

  return { receive, show, take };
};
