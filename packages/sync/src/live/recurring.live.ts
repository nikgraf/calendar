import { googleInstanceId } from '@calendar/core';
import { EventRepo } from '@calendar/db';
import type { EventMutationsShape } from '../mutationTypes.ts';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';
import {
  LIVE_ACCOUNT_ID,
  liveEngineLayer,
  liveGoogleConfigFromEnv,
} from '../testing/liveGoogle.ts';
import { bootstrap, HOUR, hoursFromNow, pendingOps, titleFor, scratchFor } from './support.ts';

/**
 * Recurring series on the real API: masters round-trip with
 * `singleEvents=false`, an instance edit becomes an exception under
 * Google's `<master>_<basetime>` id, a "this and following" split leaves
 * an UNTIL master plus a new one, and a series rename spares exceptions.
 */

const config = liveGoogleConfigFromEnv();
const scratch = scratchFor(config, { calendars: ['recurring'] });
const calendar = () => scratch.calendars[0]!;
const WEEK = 7 * 24 * HOUR;

/** A weekly master starting two hours from now, six occurrences; each test gets its own. */
const createWeekly = (mutations: Pick<EventMutationsShape, 'createEvent'>, name: string) =>
  mutations.createEvent({
    accountId: LIVE_ACCOUNT_ID,
    calendarId: calendar(),
    endUtc: hoursFromNow(3),
    isAllDay: false,
    recurrence: ['RRULE:FREQ=WEEKLY;COUNT=6'],
    startTimeZone: 'Europe/Vienna',
    startUtc: hoursFromNow(2),
    title: titleFor(config, name),
  });

const target = (masterId: string, originalStartUtc: number) => ({
  accountId: LIVE_ACCOUNT_ID,
  calendarId: calendar(),
  masterId,
  originalStartUtc,
});

describe('live Google: recurring series', () => {
  it.live('a weekly master round-trips as one row', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const master = yield* createWeekly(mutations, 'weekly');
      yield* mutations.processPendingOps();
      const server = yield* google.getEvent(calendar(), master.id);
      expect(server.recurrence?.some((line) => line.includes('FREQ=WEEKLY'))).toBe(true);
      expect(server.recurrence?.some((line) => line.includes('COUNT=6'))).toBe(true);
      yield* engine.syncAll();
      const events = yield* EventRepo;
      const row = yield* events.getById(LIVE_ACCOUNT_ID, calendar(), master.id);
      expect(row?.recurrence?.length).toBe(1);
      expect(yield* events.listOverrides(LIVE_ACCOUNT_ID, calendar(), master.id)).toEqual([]);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('an instance edit becomes an exception under Google’s instance id', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const master = yield* createWeekly(mutations, 'instance');
      yield* mutations.processPendingOps();
      const second = master.startUtc + WEEK;
      yield* mutations.updateRecurring({
        ...target(master.id, second),
        changes: { title: `${master.title} (second)` },
        scope: 'instance',
      });
      yield* mutations.processPendingOps();
      const instanceId = googleInstanceId(master.id, second, false);
      const exception = yield* google.getEvent(calendar(), instanceId);
      expect(exception.recurringEventId).toBe(master.id);
      expect(exception.summary).toBe(`${master.title} (second)`);
      expect(yield* pendingOps).toEqual([]);
      // The pull agrees with what the editor wrote.
      yield* engine.syncAll();
      const overrides = yield* (yield* EventRepo).listOverrides(
        LIVE_ACCOUNT_ID,
        calendar(),
        master.id,
      );
      expect(overrides.map((row) => [row.id, row.title])).toEqual([
        [instanceId, `${master.title} (second)`],
      ]);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('deleting one occurrence leaves a cancelled instance the pull keeps hidden', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const master = yield* createWeekly(mutations, 'skip');
      yield* mutations.processPendingOps();
      const third = master.startUtc + 2 * WEEK;
      yield* mutations.deleteRecurring({ ...target(master.id, third), scope: 'instance' });
      yield* mutations.processPendingOps();
      const instanceId = googleInstanceId(master.id, third, false);
      expect((yield* google.getEvent(calendar(), instanceId)).status).toBe('cancelled');
      yield* engine.syncAll();
      const events = yield* EventRepo;
      const row = yield* events.getById(LIVE_ACCOUNT_ID, calendar(), instanceId);
      // Either a cancelled tombstone row or nothing — never a visible occurrence.
      expect(row === null || row.status === 'cancelled').toBe(true);
      const window = yield* events.getWindow(third - HOUR, third + 2 * HOUR);
      expect(window.singles.some((single) => single.id === instanceId)).toBe(false);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('this-and-following truncates the master with UNTIL and starts a new one', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const master = yield* createWeekly(mutations, 'split');
      yield* mutations.processPendingOps();
      const fourth = master.startUtc + 3 * WEEK;
      yield* mutations.updateRecurring({
        ...target(master.id, fourth),
        changes: { title: `${master.title} (tail)` },
        scope: 'following',
      });
      yield* mutations.processPendingOps();
      expect(yield* pendingOps).toEqual([]);
      const truncated = yield* google.getEvent(calendar(), master.id);
      expect(truncated.recurrence?.some((line) => line.includes('UNTIL='))).toBe(true);
      const tails = yield* google.findEvents(calendar(), `${master.title} (tail)`);
      const tail = tails.find((event) => event.recurrence !== undefined);
      expect(tail?.recurrence?.some((line) => line.includes('COUNT=3'))).toBe(true);
      // Both masters come back as the editor left them.
      yield* engine.syncAll();
      const events = yield* EventRepo;
      expect((yield* events.getById(LIVE_ACCOUNT_ID, calendar(), master.id))?.recurrence).toEqual(
        truncated.recurrence,
      );
      expect((yield* events.getById(LIVE_ACCOUNT_ID, calendar(), tail!.id))?.title).toBe(
        `${master.title} (tail)`,
      );
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('a series rename reaches the master and spares an exception', () =>
    Effect.gen(function* () {
      const { mutations, scratch: google } = yield* bootstrap(config);
      const master = yield* createWeekly(mutations, 'rename');
      yield* mutations.processPendingOps();
      const second = master.startUtc + WEEK;
      yield* mutations.updateRecurring({
        ...target(master.id, second),
        changes: { title: `${master.title} (exception)` },
        scope: 'instance',
      });
      yield* mutations.processPendingOps();
      yield* mutations.updateRecurring({
        ...target(master.id, master.startUtc),
        changes: { title: `${master.title} (series)` },
        scope: 'series',
      });
      yield* mutations.processPendingOps();
      expect((yield* google.getEvent(calendar(), master.id)).summary).toBe(
        `${master.title} (series)`,
      );
      const instanceId = googleInstanceId(master.id, second, false);
      expect((yield* google.getEvent(calendar(), instanceId)).summary).toBe(
        `${master.title} (exception)`,
      );
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );
});
