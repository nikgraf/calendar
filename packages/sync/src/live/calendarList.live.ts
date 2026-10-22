import { eventsScope } from '@calendar/core';
import { CalendarRepo, EventRepo, SyncStateRepo } from '@calendar/db';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vite-plus/test';
import {
  LIVE_ACCOUNT_ID,
  liveEngineLayer,
  liveGoogleConfigFromEnv,
  scratchName,
} from '../testing/liveGoogle.ts';
import { bootstrap, deletedStatus, drain, hoursFromNow, httpStatus, titleFor } from './support.ts';

/**
 * The calendarList sync token on the real API: a calendar created after
 * the first pass arrives incrementally, and one deleted on Google takes
 * its events and its events sync state with it once Google lets go of it.
 */

const config = liveGoogleConfigFromEnv();
// This file creates (and deletes) its own calendar inside the test —
// creating one is what it tests.

// Six minutes of polling plus the setup: past the 300 s default.
describe('live Google: calendarList', { timeout: 480_000 }, () => {
  it.live('a calendar created after the first pass arrives, and its removal cascades', (ctx) =>
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
        const deletedAt = Date.now();
        const purged = Effect.map(
          calendars.list(LIVE_ACCOUNT_ID),
          (rows) => !rows.some((entry) => entry.id === id),
        );
        // Google's replicas disagree about a deleted calendar for minutes.
        // A delta reports the deletion only if its replica has it, and one
        // that missed it never does later; a lagging replica still lists
        // the calendar and answers 200 for its events. The engine then
        // waits for a 404 to relist in full, so how soon the purge lands is
        // Google's to decide: past three minutes on three nightlies, five
        // to six in a probe. Poll for six.
        let removed = false;
        while (!removed && Date.now() < deletedAt + 360_000) {
          yield* engine.syncAll();
          removed = yield* purged;
          if (!removed) {
            yield* Effect.sleep('10 seconds');
          }
        }
        if (!removed) {
          // Still here: ask Google itself. While it lists the calendar or
          // serves its event, there is nothing to purge yet — that is a
          // skip, not an engine failure.
          const listed = yield* scratch.getCalendarListEntry(id).pipe(
            Effect.as(true),
            Effect.catchTag('LiveGoogleError', (error) =>
              httpStatus(error) === 404 ? Effect.succeed(false) : Effect.fail(error),
            ),
          );
          const served = (yield* deletedStatus(scratch, id, record.id)) === 'confirmed';
          if (listed || served) {
            const seconds = Math.round((Date.now() - deletedAt) / 1000);
            ctx.skip(
              `Google still ${listed ? 'lists the calendar' : 'serves its event'} ${seconds} s after deleting it`,
            );
          }
          // Gone on Google: one pass may only meet the 404, the next relists.
          for (let pass = 0; pass < 2 && !removed; pass++) {
            yield* engine.syncAll();
            removed = yield* purged;
          }
        }
        expect(removed, 'the calendar is purged once Google no longer has it').toBe(true);
        expect(yield* (yield* EventRepo).getById(LIVE_ACCOUNT_ID, id, record.id)).toBeNull();
        expect(yield* state.get(LIVE_ACCOUNT_ID, eventsScope(id))).toBeNull();
      }).pipe(Effect.ensuring(Effect.ignore(scratch.deleteCalendar(id))));
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );
});
