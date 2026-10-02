import {
  type AppleCalendarClientShape,
  type AppleCalendarError,
  type AppleEventJson,
  type BatchWrite,
  type EventWrite,
} from '@calendar/apple-calendar';
import {
  type Account,
  type CalendarInfo,
  encodeMirrorProperty,
  encodeMirrorUrl,
  type EventRecord,
  keyHashOfMirrorEventId,
  MIRROR_PROPERTY_KEY,
  type MirrorActual,
  type MirrorCopy,
  mirrorEventId,
  type MirrorMarker,
  type MirrorOp,
  parseMirrorProperty,
  parseMirrorUrl,
  Temporal,
} from '@calendar/core';
import { EventRepo } from '@calendar/db';
import {
  type GcalEventReplace,
  GoogleCalendarClient,
  type GoogleRequestError,
  mapGcalEvent,
} from '@calendar/google';
import { Clock, Context, Duration, Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import { SyncEngine } from './engine.ts';

/**
 * A mirror's destination calendar: read the copies it holds, write the
 * plan's changes. The two providers differ in everything below this
 * line — Google copies are stored rows written through the REST client,
 * Apple copies live in EventKit only — and in nothing above it.
 *
 * Writes go straight to the provider, not through the pending-op queue:
 * a copy is derived, the next run recomputes whatever did not land, and
 * the queue would list every copy in the user's unsynced changes.
 */

/** How a write stamps the copy: which mirror, at which revision. */
export interface MirrorStamp {
  readonly rev: number;
  readonly tag: string;
  /** The mirror's zone: timed copies are written in it, never in the source's. */
  readonly timeZone: string;
}

export interface MirrorApplyResult {
  /** How many ops landed. */
  readonly applied: number;
  /** Ops that were attempted and refused (by index); the rest up to `processed` landed. */
  readonly failedIndices: ReadonlyArray<number>;
  /**
   * A copy in the destination carries a newer definition than this
   * device's: the writes stopped there, and the mirror must stand back.
   */
  readonly newestRev?: number | undefined;
  /** How many ops were attempted, in order from the first. */
  readonly processed: number;
  /** Google said to slow down: the run ends here and the next one continues. */
  readonly rateLimited: boolean;
}

export type MirrorDestinationError = AppleCalendarError | GoogleRequestError | SqlError;

export interface MirrorDestination {
  /** Writes ops in order until `deadlineMs`. */
  readonly apply: (
    ops: ReadonlyArray<MirrorOp<unknown>>,
    stamp: MirrorStamp,
    deadlineMs: number,
  ) => Effect.Effect<MirrorApplyResult, MirrorDestinationError>;
  /** Events in [startUtc, endUtc) that are not a mirror's: what the copies would sit among. */
  readonly countOrdinary: (
    startUtc: number,
    endUtc: number,
  ) => Effect.Effect<number, MirrorDestinationError>;
  /** Every marked event starting in [startUtc, endUtc), whichever mirror wrote it. */
  readonly read: (
    startUtc: number,
    endUtc: number,
  ) => Effect.Effect<ReadonlyArray<MirrorActual<unknown>>, MirrorDestinationError>;
}

/**
 * The pause between two Google writes. Bursts are answered with 403
 * rateLimitExceeded; a few writes a second are not.
 */
export const MirrorWritePace = Context.Reference<Duration.Input>('sync/MirrorWritePace', {
  defaultValue: () => '250 millis',
});

/** Google writes between two acks: one transaction and one invalidation per chunk. */
const GOOGLE_CHUNK = 25;

const markerOf = (copy: MirrorCopy, stamp: MirrorStamp): MirrorMarker => ({
  contentHash: copy.contentHash,
  rev: stamp.rev,
  tag: stamp.tag,
});

const iso = (ms: number): string => Temporal.Instant.fromEpochMilliseconds(ms).toString();

/**
 * The whole event as Google will hold it. Built from the copy alone: no
 * guests, no reminders (`useDefault: false` with none — the calendar's
 * default would notify everyone it is shared with), no conference, and
 * nothing of the source event that the copy does not name.
 */
const googleBody = (copy: MirrorCopy, stamp: MirrorStamp): GcalEventReplace => ({
  ...(copy.description === undefined ? {} : { description: copy.description }),
  end: copy.allDay
    ? { date: copy.endDate }
    : { dateTime: iso(copy.endUtc), timeZone: stamp.timeZone },
  extendedProperties: {
    private: { [MIRROR_PROPERTY_KEY]: encodeMirrorProperty(markerOf(copy, stamp)) },
  },
  id: mirrorEventId(copy.keyHash),
  ...(copy.location === undefined ? {} : { location: copy.location }),
  reminders: { overrides: [], useDefault: false },
  start: copy.allDay
    ? { date: copy.startDate }
    : { dateTime: iso(copy.startUtc), timeZone: stamp.timeZone },
  summary: copy.title,
});

interface GoogleRef {
  readonly etag: string | null;
  readonly id: string;
}

const googleActual = (row: EventRecord): MirrorActual<GoogleRef> | undefined => {
  const keyHash = keyHashOfMirrorEventId(row.id);
  const marker = parseMirrorProperty(row.mirror);
  return keyHash === undefined || marker === undefined
    ? undefined
    : {
        allDay: row.isAllDay,
        endDate: row.endDate,
        endUtc: row.endUtc,
        keyHash,
        marker,
        order: row.id,
        ref: { etag: row.etag, id: row.id },
        startDate: row.startDate,
        startUtc: row.startUtc,
      };
};

export const googleMirrorDestination = (
  account: Account,
  calendar: CalendarInfo,
): Effect.Effect<MirrorDestination, never, EventRepo | GoogleCalendarClient | SyncEngine> =>
  Effect.gen(function* () {
    const events = yield* EventRepo;
    const client = yield* GoogleCalendarClient;
    const engine = yield* SyncEngine;
    const target = { accountId: account.id, calendarId: calendar.id };

    type Outcome =
      | { readonly id: string; readonly kind: 'gone' }
      | { readonly kind: 'newer'; readonly rev: number }
      | { readonly kind: 'rateLimited' }
      | { readonly kind: 'skipped' }
      | { readonly kind: 'written'; readonly row: EventRecord | null };

    const written = (response: Parameters<typeof mapGcalEvent>[0], syncedAt: number): Outcome => ({
      kind: 'written',
      row: mapGcalEvent(response, { ...target, defaultTimeZone: 'UTC', syncedAt }),
    });

    /** One op against Google. `skipped`: this device's row is stale; the next pull sorts it out. */
    const write = (
      op: MirrorOp<unknown>,
      stamp: MirrorStamp,
      now: number,
    ): Effect.Effect<Outcome, GoogleRequestError> => {
      if (op.kind === 'create') {
        const event = googleBody(op.copy, stamp);
        const eventId = mirrorEventId(op.copy.keyHash);
        // The id is taken: another device wrote this copy — a moment ago,
        // or under a definition this device has not seen — or it was
        // deleted earlier and Google keeps the id reserved. Look before
        // replacing: a blind replace would put an older definition's
        // content (a location since switched off) back on the shared copy.
        const taken: Effect.Effect<Outcome, GoogleRequestError> = Effect.gen(function* () {
          const existing = yield* client
            .getEvent({ ...target, eventId })
            .pipe(Effect.catchTag('NotFoundError', () => Effect.succeed(undefined)));
          const live = existing !== undefined && existing.status !== 'cancelled';
          const marker = parseMirrorProperty(
            existing?.extendedProperties?.private?.[MIRROR_PROPERTY_KEY],
          );
          if (live && marker !== undefined && marker.tag === stamp.tag) {
            if (marker.rev > stamp.rev) {
              return { kind: 'newer', rev: marker.rev } as Outcome;
            }
            if (marker.contentHash === op.copy.contentHash) {
              // The same copy, written by the other device: take it as is.
              return written(existing, now);
            }
          }
          return yield* client
            .replaceEvent({
              ...target,
              ...(live && existing.etag ? { baseEtag: existing.etag } : {}),
              event: { ...event, status: 'confirmed' },
              eventId,
              sendUpdates: 'none',
            })
            .pipe(
              Effect.map((response) => written(response, now)),
              Effect.catchTag('ConflictError', () => Effect.succeed<Outcome>({ kind: 'skipped' })),
            );
        });
        return client.insertEvent({ ...target, event, sendUpdates: 'none' }).pipe(
          Effect.map((response) => written(response, now)),
          Effect.catchIf(
            (error) => error._tag === 'GoogleApiError' && error.status === 409,
            () => taken,
          ),
        );
      }
      const ref = op.actual.ref as GoogleRef;
      const baseEtag = ref.etag ?? undefined;
      if (op.kind === 'update') {
        return client
          .replaceEvent({
            ...target,
            baseEtag,
            event: googleBody(op.copy, stamp),
            eventId: ref.id,
            sendUpdates: 'none',
          })
          .pipe(
            Effect.map((response) => written(response, now)),
            Effect.catchTag('ConflictError', () => Effect.succeed<Outcome>({ kind: 'skipped' })),
            Effect.catchTag('NotFoundError', () =>
              Effect.succeed<Outcome>({ id: ref.id, kind: 'gone' }),
            ),
          );
      }
      // delete, and a second event under one key (which a derived id rules out on Google).
      return client.deleteEvent({ ...target, baseEtag, eventId: ref.id }).pipe(
        Effect.as<Outcome>({ id: ref.id, kind: 'gone' }),
        Effect.catchTag('ConflictError', () => Effect.succeed<Outcome>({ kind: 'skipped' })),
        Effect.catchTags({
          NotFoundError: () => Effect.succeed<Outcome>({ id: ref.id, kind: 'gone' }),
          SyncTokenExpiredError: () => Effect.succeed<Outcome>({ id: ref.id, kind: 'gone' }),
        }),
      );
    };

    const applyChunk = (
      ops: ReadonlyArray<MirrorOp<unknown>>,
      stamp: MirrorStamp,
      deadlineMs: number,
    ): Effect.Effect<MirrorApplyResult, MirrorDestinationError> =>
      Effect.gen(function* () {
        const pace = yield* MirrorWritePace;
        const upserts: Array<EventRecord> = [];
        const deletions: Array<string> = [];
        let applied = 0;
        let rateLimited = false;
        let newestRev: number | undefined;
        for (const op of ops) {
          const now = yield* Clock.currentTimeMillis;
          // A plan is only good for a while: a process that was suspended
          // (a closed lid, a backgrounded app) wakes up with a stale one.
          if (now >= deadlineMs) {
            break;
          }
          const outcome = yield* write(op, stamp, now).pipe(
            Effect.catchTag('RateLimitedError', () =>
              Effect.succeed<Outcome>({ kind: 'rateLimited' }),
            ),
          );
          if (outcome.kind === 'rateLimited') {
            rateLimited = true;
            break;
          }
          if (outcome.kind === 'newer') {
            newestRev = outcome.rev;
            break;
          }
          if (outcome.kind === 'written' && outcome.row !== null) {
            upserts.push(outcome.row);
          } else if (outcome.kind === 'gone') {
            deletions.push(outcome.id);
          }
          applied += 1;
          if (Duration.toMillis(Duration.fromInputUnsafe(pace)) > 0) {
            yield* Effect.sleep(pace);
          }
        }
        // The rows follow the writes at once, so the next run compares
        // against what was just written rather than writing it again.
        if (upserts.length > 0 || deletions.length > 0) {
          yield* events.applyPage(account.id, calendar.id, { deletions, mode: 'ack', upserts });
        }
        return { applied, failedIndices: [], newestRev, processed: applied, rateLimited };
      });

    return {
      apply: (ops, stamp, deadlineMs) =>
        Effect.gen(function* () {
          let applied = 0;
          for (let index = 0; index < ops.length; index += GOOGLE_CHUNK) {
            const chunk = ops.slice(index, index + GOOGLE_CHUNK);
            // Under the sync gate: a pull landing between a write and its
            // ack would put the old row back until the next pass.
            const result = yield* engine.exclusive(applyChunk(chunk, stamp, deadlineMs));
            applied += result.applied;
            if (
              result.rateLimited ||
              result.newestRev !== undefined ||
              result.applied < chunk.length
            ) {
              return {
                applied,
                failedIndices: [],
                newestRev: result.newestRev,
                processed: applied,
                rateLimited: result.rateLimited,
              };
            }
          }
          return { applied, failedIndices: [], processed: applied, rateLimited: false };
        }),
      countOrdinary: (startUtc, endUtc) =>
        events.countOrdinary(account.id, calendar.id, startUtc, endUtc),
      read: (startUtc, endUtc) =>
        Effect.map(events.listMirrorCopies(account.id, calendar.id, startUtc, endUtc), (rows) =>
          rows.flatMap((row) => googleActual(row) ?? []),
        ),
    };
  });

interface AppleRef {
  readonly event: AppleEventJson;
}

/**
 * The whole copy as EventKit will hold it. Every field a copy can carry
 * is sent, absent ones as an explicit null: a switched-off location must
 * leave the shared calendar, and an alarm someone added must not ring
 * for everyone.
 */
const appleWrite = (copy: MirrorCopy, stamp: MirrorStamp): EventWrite => ({
  alarms: null,
  description: copy.description ?? null,
  isAllDay: copy.allDay,
  location: copy.location ?? null,
  title: copy.title,
  url: encodeMirrorUrl({ ...markerOf(copy, stamp), keyHash: copy.keyHash }),
  ...(copy.allDay
    ? { endDate: copy.endDate, startDate: copy.startDate }
    : { endUtc: copy.endUtc, startUtc: copy.startUtc, timeZone: stamp.timeZone }),
});

/** Whether two events show the same thing — the test a duplicate must pass to be removed. */
const sameEvent = (a: AppleEventJson, b: AppleEventJson): boolean =>
  a.title === b.title &&
  a.isAllDay === b.isAllDay &&
  a.startUtc === b.startUtc &&
  a.endUtc === b.endUtc &&
  a.startDate === b.startDate &&
  a.endDate === b.endDate &&
  (a.location ?? '') === (b.location ?? '') &&
  (a.description ?? '') === (b.description ?? '');

export const appleMirrorDestination = (
  client: AppleCalendarClientShape,
  calendar: CalendarInfo,
): MirrorDestination => {
  const inCalendar = (startUtc: number, endUtc: number) =>
    Effect.map(client.events({ endUtc, startUtc }), (events) =>
      events.filter(
        (event) =>
          event.calendarId === calendar.id &&
          event.status !== 'cancelled' &&
          event.startUtc >= startUtc &&
          event.startUtc < endUtc,
      ),
    );

  const batchWrite = (op: MirrorOp<unknown>, stamp: MirrorStamp): BatchWrite => {
    if (op.kind === 'create') {
      return { calendarId: calendar.id, event: appleWrite(op.copy, stamp), kind: 'create' };
    }
    const ref = { id: (op.actual.ref as AppleRef).event.id };
    if (op.kind === 'update') {
      return { changes: appleWrite(op.copy, stamp), kind: 'update', ref };
    }
    if (op.kind === 'delete') {
      return { kind: 'delete', ref };
    }
    // Two events under one key. When they show the same thing, two
    // devices raced and the extra one goes. When they differ, someone
    // duplicated a copy and made it theirs: it only loses the marker.
    return sameEvent((op.actual.ref as AppleRef).event, (op.kept.ref as AppleRef).event)
      ? { kind: 'delete', ref }
      : { changes: { url: null }, kind: 'update', ref };
  };

  return {
    // One commit for the whole batch: nothing is half-written when the
    // process is cut off, so the deadline is checked once, up front.
    apply: (ops, stamp, deadlineMs) =>
      Effect.gen(function* () {
        if (ops.length === 0 || (yield* Clock.currentTimeMillis) >= deadlineMs) {
          return { applied: 0, failedIndices: [], processed: 0, rateLimited: false };
        }
        const failures = yield* client.applyBatch({
          ops: ops.map((op) => batchWrite(op, stamp)),
        });
        // An event that is already gone needs no update or delete; a
        // create that found nothing (its calendar is gone) did not land.
        // Refused writes stay pending (indices only — a log never carries
        // a title).
        const real = failures.filter(
          (failure) =>
            !failure.message.startsWith('notFound:') || ops[failure.index]?.kind === 'create',
        );
        if (real.length > 0) {
          yield* Effect.logWarning('mirror: apple writes refused', {
            count: real.length,
            first: real[0]?.message,
          });
        }
        const failedIndices = real.map((failure) => failure.index);
        return {
          applied: ops.length - failedIndices.length,
          failedIndices,
          processed: ops.length,
          rateLimited: false,
        };
      }),
    countOrdinary: (startUtc, endUtc) =>
      Effect.map(
        inCalendar(startUtc, endUtc),
        (events) => events.filter((event) => parseMirrorUrl(event.url) === undefined).length,
      ),
    read: (startUtc, endUtc) =>
      Effect.map(inCalendar(startUtc, endUtc), (events) =>
        events.flatMap((event): Array<MirrorActual<AppleRef>> => {
          const marker = parseMirrorUrl(event.url);
          // A copy is a single event. One that became a series is someone
          // else's doing; it is left exactly as it is.
          if (marker === undefined || event.hasRecurrence || event.isDetached) {
            return [];
          }
          return [
            {
              allDay: event.isAllDay,
              endDate: event.endDate,
              endUtc: event.endUtc,
              keyHash: marker.keyHash,
              marker,
              // The external identifier: two devices keep the same one of a pair.
              order: event.externalId ?? event.id,
              ref: { event },
              startDate: event.startDate,
              startUtc: event.startUtc,
            },
          ];
        }),
      ),
  };
};
