import { googleInstanceId } from '@calendar/core';
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
  HOUR,
  hoursFromNow,
  noYield,
  pendingOps,
  titleFor,
  scratchFor,
  drain,
} from './support.ts';

/**
 * `events.move` on the real API: the event keeps its id in the destination
 * and leaves a tombstone behind, an edit queued before the move lands after
 * it (the move bumps the etag, so the re-queued edit must not 412), and a
 * master takes its exceptions along.
 */

const config = liveGoogleConfigFromEnv();
const scratch = scratchFor(config);
const source = () => scratch.calendars[0]!;
const destination = () => scratch.calendars[1]!;

const draft = (name: string, extra: Record<string, unknown> = {}) => ({
  accountId: LIVE_ACCOUNT_ID,
  calendarId: source(),
  endUtc: hoursFromNow(3),
  isAllDay: false,
  // UTC: the instance-id test below names an occurrence as start + a week.
  startTimeZone: 'UTC',
  startUtc: hoursFromNow(2),
  title: titleFor(config, name),
  ...extra,
});

const move = (eventId: string) => ({
  accountId: LIVE_ACCOUNT_ID,
  calendarId: source(),
  eventId,
  target: { accountId: LIVE_ACCOUNT_ID, calendarId: destination() },
});

describe('live Google: moves between calendars', () => {
  it.live('a same-account move keeps the id and leaves a tombstone in the source', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const record = yield* mutations.createEvent(draft('move'));
      yield* drain(mutations);
      yield* mutations.moveEvent(move(record.id));
      yield* engine.syncAll();
      expect((yield* google.getEvent(destination(), record.id)).summary).toBe(record.title);
      expect(GONE.has(yield* deletedStatus(google, source(), record.id))).toBe(true);
      const events = yield* EventRepo;
      expect(yield* events.getById(LIVE_ACCOUNT_ID, source(), record.id)).toBeNull();
      expect((yield* events.getById(LIVE_ACCOUNT_ID, destination(), record.id))?.syncStatus).toBe(
        'synced',
      );
      expect(yield* pendingOps).toEqual([]);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('an edit saved just before a move lands after it, in the destination', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const record = yield* mutations.createEvent(draft('edit-then-move'));
      yield* drain(mutations);
      // The editor's Save: the edit first, then the move, in one go — no
      // yield in between, or the edit's kicked drain could patch first and
      // the test would no longer pin the reorder.
      yield* noYield(
        Effect.gen(function* () {
          yield* mutations.updateEvent({
            accountId: LIVE_ACCOUNT_ID,
            calendarId: source(),
            changes: { title: `${record.title} (edited)` },
            eventId: record.id,
          });
          yield* mutations.moveEvent(move(record.id));
        }),
      );
      yield* engine.syncAll();
      expect((yield* google.getEvent(destination(), record.id)).summary).toBe(
        `${record.title} (edited)`,
      );
      expect(yield* pendingOps).toEqual([]);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('a moved master takes its exception along', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const master = yield* mutations.createEvent(
        draft('move-series', { recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'] }),
      );
      yield* drain(mutations);
      const second = master.startUtc + 7 * 24 * HOUR;
      yield* mutations.updateRecurring({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: source(),
        changes: { title: `${master.title} (second)` },
        masterId: master.id,
        originalStartUtc: second,
        scope: 'instance',
      });
      yield* drain(mutations);
      yield* mutations.moveEvent(move(master.id));
      yield* engine.syncAll();
      const instanceId = googleInstanceId(master.id, second, false);
      const exception = yield* google.getEvent(destination(), instanceId);
      expect(exception.recurringEventId).toBe(master.id);
      expect(exception.summary).toBe(`${master.title} (second)`);
      const overrides = yield* (yield* EventRepo).listOverrides(
        LIVE_ACCOUNT_ID,
        destination(),
        master.id,
      );
      expect(overrides.map((row) => row.id)).toEqual([instanceId]);
      expect(yield* pendingOps).toEqual([]);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );
});
