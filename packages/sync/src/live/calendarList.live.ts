import { eventsScope } from '@calendar/core';
import { CalendarRepo, EventRepo, SyncStateRepo } from '@calendar/db';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';
import {
  LIVE_ACCOUNT_ID,
  liveEngineLayer,
  liveGoogleConfigFromEnv,
  scratchName,
} from '../testing/liveGoogle.ts';
import { bootstrap, hoursFromNow, titleFor, drain } from './support.ts';

/**
 * The calendarList sync token on the real API: a calendar created after
 * the first pass arrives incrementally, and one deleted on Google takes
 * its events and its events sync state with it.
 */

const config = liveGoogleConfigFromEnv();
// This file creates (and deletes) its own calendar inside the test —
// creating one is what it tests.

describe('live Google: calendarList', () => {
  it.live('a calendar created after the first pass arrives, and its removal cascades', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch } = yield* bootstrap(config);
      const calendars = yield* CalendarRepo;
      const { id } = yield* scratch.createCalendar(scratchName(config, 'list'));
      // Effect.ensuring, not try/finally: a failing yield* never resumes
      // the generator, so a finally block would skip the cleanup.
      yield* Effect.gen(function* () {
        expect((yield* calendars.list(LIVE_ACCOUNT_ID)).some((entry) => entry.id === id)).toBe(
          false,
        );
        yield* engine.syncAll();
        const row = (yield* calendars.list(LIVE_ACCOUNT_ID)).find((entry) => entry.id === id);
        expect(row?.accessRole).toBe('owner');

        // Put something in it so the cascade has rows to remove.
        const record = yield* mutations.createEvent({
          accountId: LIVE_ACCOUNT_ID,
          calendarId: id,
          endUtc: hoursFromNow(3),
          isAllDay: false,
          startTimeZone: 'Europe/Vienna',
          startUtc: hoursFromNow(2),
          title: titleFor(config, 'in-new-calendar'),
        });
        yield* drain(mutations);
        const state = yield* SyncStateRepo;
        expect((yield* state.get(LIVE_ACCOUNT_ID, eventsScope(id)))?.syncToken).toBeTruthy();

        yield* scratch.deleteCalendar(id);
        // Google's calendarList keeps naming a deleted calendar for a while
        // (the delta may never report it); its events 404 at once, and that
        // is what the pass purges on. A few passes absorb the reverse lag,
        // events.list still answering right after the delete.
        const gone = Effect.gen(function* () {
          yield* engine.syncAll();
          return !(yield* calendars.list(LIVE_ACCOUNT_ID)).some((entry) => entry.id === id);
        });
        let removed = yield* gone;
        for (let pass = 1; pass < 4 && !removed; pass++) {
          yield* Effect.sleep('10 seconds');
          removed = yield* gone;
        }
        expect(removed, 'the deleted calendar is purged within four passes').toBe(true);
        expect(yield* (yield* EventRepo).getById(LIVE_ACCOUNT_ID, id, record.id)).toBeNull();
        expect(yield* state.get(LIVE_ACCOUNT_ID, eventsScope(id))).toBeNull();
      }).pipe(Effect.ensuring(Effect.ignore(scratch.deleteCalendar(id))));
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );
});
