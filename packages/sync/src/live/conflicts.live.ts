import { EventRepo } from '@calendar/db';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';
import {
  LIVE_ACCOUNT_ID,
  liveEngineLayer,
  liveGoogleConfigFromEnv,
} from '../testing/liveGoogle.ts';
import {
  bootstrap,
  deletedStatus,
  GONE,
  hoursFromNow,
  pendingOps,
  titleFor,
  scratchFor,
  drain,
} from './support.ts';

/**
 * 412 conflicts on the real API — the port of engine.http.test.ts's
 * `parkedEdit` to Google itself: a stale If-Match parks the op with
 * Google's copy, a pull while parked leaves the user's version alone,
 * "take theirs" and "keep mine" settle it, a parked delete deletes
 * anyway, and an edit of an event Google deleted is restored as new.
 */

const config = liveGoogleConfigFromEnv();
const scratch = scratchFor(config, { calendars: ['conflicts'] });
const calendar = () => scratch.calendars[0]!;

const draft = (name: string) => ({
  accountId: LIVE_ACCOUNT_ID,
  calendarId: calendar(),
  endUtc: hoursFromNow(3),
  isAllDay: false,
  startTimeZone: 'Europe/Vienna',
  startUtc: hoursFromNow(2),
  title: titleFor(config, name),
});

const titleOf = (eventId: string) =>
  Effect.map(
    Effect.flatMap(EventRepo, (events) => events.getById(LIVE_ACCOUNT_ID, calendar(), eventId)),
    (row) => row?.title ?? null,
  );

/** Synced event, edit 1 landed, Google moved on, edit 2 met a 412. */
const parkedEdit = (name: string) =>
  Effect.gen(function* () {
    const { engine, mutations, scratch: google } = yield* bootstrap(config);
    const record = yield* mutations.createEvent(draft(name));
    yield* drain(mutations);
    const edit = (title: string) =>
      mutations.updateEvent({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: calendar(),
        changes: { title },
        eventId: record.id,
      });

    yield* edit(`${record.title} local 1`);
    yield* drain(mutations);
    expect((yield* google.getEvent(calendar(), record.id)).summary).toBe(`${record.title} local 1`);
    expect(yield* pendingOps).toEqual([]);

    yield* google.patchEvent(calendar(), record.id, { summary: `${record.title} server 2` });
    yield* edit(`${record.title} local 2`);
    yield* drain(mutations);
    expect((yield* google.getEvent(calendar(), record.id)).summary).toBe(
      `${record.title} server 2`,
    );
    const [op] = yield* pendingOps;
    expect(op?.conflictAt).toBeDefined();
    expect(op?.serverPayload?.title).toBe(`${record.title} server 2`);

    // A pull while parked leaves the user's version alone.
    yield* engine.syncAll();
    expect(yield* titleOf(record.id)).toBe(`${record.title} local 2`);
    return { engine, google, mutations, opId: op!.id, record };
  });

describe('live Google: 412 conflicts', () => {
  it.live("a stale etag parks the edit; take theirs restores Google's copy", () =>
    Effect.gen(function* () {
      const { engine, mutations, opId, record } = yield* parkedEdit('theirs');
      yield* mutations.resolveConflict({ choice: 'theirs', opId });
      expect(yield* titleOf(record.id)).toBe(`${record.title} server 2`);
      expect(yield* pendingOps).toEqual([]);
      yield* engine.syncAll();
      expect(yield* titleOf(record.id)).toBe(`${record.title} server 2`);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('keep mine re-sends the edit without If-Match and Google takes it', () =>
    Effect.gen(function* () {
      const { engine, google, mutations, opId, record } = yield* parkedEdit('mine');
      yield* mutations.resolveConflict({ choice: 'mine', opId });
      yield* drain(mutations);
      expect((yield* google.getEvent(calendar(), record.id)).summary).toBe(
        `${record.title} local 2`,
      );
      expect(yield* pendingOps).toEqual([]);
      yield* engine.syncAll();
      expect(yield* titleOf(record.id)).toBe(`${record.title} local 2`);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('a parked delete: the pull brings the event back, delete anyway removes it', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const record = yield* mutations.createEvent(draft('parked-delete'));
      yield* drain(mutations);
      yield* google.patchEvent(calendar(), record.id, { summary: `${record.title} server 2` });
      yield* mutations.deleteEvent({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: calendar(),
        eventId: record.id,
      });
      yield* drain(mutations);
      const [op] = yield* pendingOps;
      expect(op?.kind).toBe('delete');
      expect(op?.conflictAt).toBeDefined();
      expect(op?.payload?.title).toBe(record.title);

      // Nothing local protects a deleted row, so the pull re-inserts it.
      yield* engine.syncAll();
      expect(yield* titleOf(record.id)).toBe(`${record.title} server 2`);

      yield* mutations.resolveConflict({ choice: 'mine', opId: op!.id });
      expect(yield* titleOf(record.id)).toBeNull();
      yield* drain(mutations);
      expect(GONE.has(yield* deletedStatus(google, calendar(), record.id))).toBe(true);
      yield* engine.syncAll();
      expect(yield* titleOf(record.id)).toBeNull();
      expect(yield* pendingOps).toEqual([]);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('an edit of an event Google deleted: keep mine restores it as a new event', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const record = yield* mutations.createEvent(draft('restore'));
      yield* drain(mutations);
      yield* google.deleteEvent(calendar(), record.id);
      yield* mutations.updateEvent({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: calendar(),
        changes: { title: `${record.title} (mine)` },
        eventId: record.id,
      });
      yield* drain(mutations);
      // Pins Google's answer for a stale-etag PATCH of a deleted event.
      // Expected: the delete bumped the etag, so the PATCH is a 412 and the
      // drain parks the op with Google's copy — the cancelled tombstone,
      // or null when `events.get` says gone. (A 404/410 on the PATCH
      // itself would instead take the NotFound arm: row dropped, nothing
      // parked — and this test fails, which is the point.)
      const [op] = yield* pendingOps;
      expect(op?.kind).toBe('update');
      expect(op?.conflictAt).toBeDefined();
      expect(op?.serverPayload === undefined || op.serverPayload.status === 'cancelled').toBe(true);
      yield* mutations.resolveConflict({ choice: 'mine', opId: op!.id });
      // Keep mine re-created the row under a fresh id before the drain ran.
      const window = yield* (yield* EventRepo).getWindow(0, Number.MAX_SAFE_INTEGER);
      const restoredRow = window.singles.find((row) => row.title === `${record.title} (mine)`);
      expect(restoredRow).toBeDefined();
      expect(restoredRow!.id).not.toBe(record.id);
      yield* drain(mutations);
      const restored = yield* google.getEvent(calendar(), restoredRow!.id);
      expect(restored.summary).toBe(`${record.title} (mine)`);
      expect(restored.status).not.toBe('cancelled');
      yield* engine.syncAll();
      expect(yield* titleOf(record.id)).toBeNull();
      expect(yield* titleOf(restoredRow!.id)).toBe(`${record.title} (mine)`);
      expect(yield* pendingOps).toEqual([]);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );
});
