import { assembleWindow, compactUtc, googleInstanceId } from '@calendar/core';
import { EventRepo } from '@calendar/db';
import { GoogleCalendarClient } from '@calendar/google';
import type { EventMutationsShape } from '../mutationTypes.ts';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vite-plus/test';
import {
  LIVE_ACCOUNT_ID,
  liveEngineLayer,
  liveGoogleConfigFromEnv,
  type LiveScratchShape,
} from '../testing/liveGoogle.ts';
import {
  bootstrap,
  HOUR,
  hoursFromNow,
  noYield,
  pendingOps,
  titleFor,
  scratchFor,
  drain,
} from './support.ts';

/**
 * Recurring series on the real API: masters round-trip with
 * `singleEvents=false`, an instance edit becomes an exception under
 * Google's `<master>_<basetime>` id, a "this and following" split leaves
 * an UNTIL master plus a new one (also on an RDATE occurrence the rule
 * skips), a set of only RDATE lines expands like Google's, a series
 * rename spares exceptions, and a new rule keeps the exceptions whose
 * slots it still draws and cancels the rest.
 */

const config = liveGoogleConfigFromEnv();
const scratch = scratchFor(config);
const calendar = () => scratch.calendars[0]!;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

/**
 * A weekly master starting two hours from now, six occurrences; each test
 * gets its own. UTC on purpose: Google's instance ids carry the
 * occurrence's UTC instant, and a zoned weekly rule shifts by an hour
 * across a DST change — `start + n * WEEK` would name the wrong instance.
 */
const createWeekly = (mutations: Pick<EventMutationsShape, 'createEvent'>, name: string) =>
  mutations.createEvent({
    accountId: LIVE_ACCOUNT_ID,
    calendarId: calendar(),
    endUtc: hoursFromNow(3),
    isAllDay: false,
    recurrence: ['RRULE:FREQ=WEEKLY;COUNT=6'],
    startTimeZone: 'UTC',
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
      yield* drain(mutations);
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
      yield* drain(mutations);
      const second = master.startUtc + WEEK;
      yield* mutations.updateRecurring({
        ...target(master.id, second),
        changes: { title: `${master.title} (second)` },
        scope: 'instance',
      });
      yield* drain(mutations);
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
      yield* drain(mutations);
      const third = master.startUtc + 2 * WEEK;
      yield* mutations.deleteRecurring({ ...target(master.id, third), scope: 'instance' });
      yield* drain(mutations);
      const instanceId = googleInstanceId(master.id, third, false);
      expect((yield* google.getEvent(calendar(), instanceId)).status).toBe('cancelled');
      yield* engine.syncAll();
      const events = yield* EventRepo;
      const row = yield* events.getById(LIVE_ACCOUNT_ID, calendar(), instanceId);
      expect(row === null || row.status === 'cancelled').toBe(true);
      // What the calendar renders: without the tombstone the master would
      // expand the deleted occurrence again. Its neighbours stay.
      const from = third - WEEK - HOUR;
      const to = third + WEEK + 2 * HOUR;
      const starts = assembleWindow(yield* events.getWindow(from, to), from, to)
        .filter((event) => event.recurringEventId === master.id)
        .map((event) => event.originalStartUtc);
      expect(starts).toEqual([third - WEEK, third + WEEK]);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('this-and-following truncates the master with UNTIL and starts a new one', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const master = yield* createWeekly(mutations, 'split');
      yield* drain(mutations);
      const fourth = master.startUtc + 3 * WEEK;
      yield* mutations.updateRecurring({
        ...target(master.id, fourth),
        changes: { title: `${master.title} (tail)` },
        scope: 'following',
      });
      yield* drain(mutations);
      expect(yield* pendingOps).toEqual([]);
      const truncated = yield* google.getEvent(calendar(), master.id);
      expect(truncated.recurrence?.some((line) => line.includes('UNTIL='))).toBe(true);
      // The split's new master is a local row already; Google has it under that id.
      const events = yield* EventRepo;
      const window = yield* events.getWindow(0, Number.MAX_SAFE_INTEGER);
      const tailRow = window.masters.find((row) => row.title === `${master.title} (tail)`);
      expect(tailRow).toBeDefined();
      const tail = yield* google.getEvent(calendar(), tailRow!.id);
      expect(tail.recurrence?.some((line) => line.includes('COUNT=3'))).toBe(true);
      // Both masters come back as the editor left them.
      yield* engine.syncAll();
      expect((yield* events.getById(LIVE_ACCOUNT_ID, calendar(), master.id))?.recurrence).toEqual(
        truncated.recurrence,
      );
      expect((yield* events.getById(LIVE_ACCOUNT_ID, calendar(), tailRow!.id))?.title).toBe(
        `${master.title} (tail)`,
      );
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('a set of only RDATE lines: DTSTART is an instance on Google and here', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const start = hoursFromNow(2);
      const dates = [start + WEEK, start + 2 * WEEK];
      const master = yield* mutations.createEvent({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: calendar(),
        endUtc: start + HOUR,
        isAllDay: false,
        recurrence: [`RDATE:${dates.map(compactUtc).join(',')}`],
        startTimeZone: 'UTC',
        startUtc: start,
        title: titleFor(config, 'rdate'),
      });
      yield* drain(mutations);
      const server = yield* google.getEvent(calendar(), master.id);
      expect(server.recurrence?.every((line) => line.startsWith('RDATE'))).toBe(true);
      // Editing the DTSTART occurrence only works if Google counts it as
      // an instance of the set (RFC 5545): the PATCH would 404 otherwise.
      yield* mutations.updateRecurring({
        ...target(master.id, start),
        changes: { title: `${master.title} (first)` },
        scope: 'instance',
      });
      yield* drain(mutations);
      expect(yield* pendingOps).toEqual([]);
      const first = yield* google.getEvent(calendar(), googleInstanceId(master.id, start, false));
      expect(first.recurringEventId).toBe(master.id);
      // After a pull the calendar draws the edited first occurrence and
      // both dates — Google's ids, our expansion.
      yield* engine.syncAll();
      const events = yield* EventRepo;
      const from = start - HOUR;
      const to = start + 3 * WEEK;
      const starts = assembleWindow(yield* events.getWindow(from, to), from, to)
        .filter((event) => event.recurringEventId === master.id)
        .map((event) => event.originalStartUtc);
      expect(starts).toEqual([start, ...dates]);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('this-and-following on an RDATE occurrence its rule skips keeps it, as Google does', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const start = hoursFromNow(2);
      const weekday = WEEKDAYS[new Date(start).getUTCDay()]!;
      // Two days after the second occurrence: a day the rule skips.
      const extra = start + WEEK + 2 * DAY;
      const master = yield* mutations.createEvent({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: calendar(),
        endUtc: start + HOUR,
        isAllDay: false,
        recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${weekday};COUNT=4`, `RDATE:${compactUtc(extra)}`],
        startTimeZone: 'UTC',
        startUtc: start,
        title: titleFor(config, 'rdate-split'),
      });
      yield* drain(mutations);
      yield* mutations.updateRecurring({
        ...target(master.id, extra),
        changes: { title: `${master.title} (tail)` },
        scope: 'following',
      });
      yield* drain(mutations);
      expect(yield* pendingOps).toEqual([]);
      yield* engine.syncAll();
      const events = yield* EventRepo;
      const tail = (yield* events.getWindow(0, Number.MAX_SAFE_INTEGER)).masters.find(
        (row) => row.title === `${master.title} (tail)`,
      );
      expect(tail).toBeDefined();
      // Google's own expansion of both halves: the extra date starts the tail…
      const onGoogle = (yield* Effect.forEach([master.id, tail!.id], (id) =>
        google.listInstances(calendar(), id),
      ))
        .flat()
        .map((instance) => Date.parse(instance.start?.dateTime ?? ''))
        .sort((a, b) => a - b);
      expect(onGoogle).toEqual([start, start + WEEK, extra, start + 2 * WEEK, start + 3 * WEEK]);
      // …and the calendar draws the same after a pull.
      const from = start - HOUR;
      const to = start + 4 * WEEK;
      const drawn = assembleWindow(yield* events.getWindow(from, to), from, to)
        .filter(
          (event) => event.recurringEventId === master.id || event.recurringEventId === tail!.id,
        )
        .map((event) => event.startUtc)
        .sort((a, b) => a - b);
      expect(drawn).toEqual(onGoogle);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('a series rename reaches the master and overwrites an exception’s title', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const master = yield* createWeekly(mutations, 'rename');
      yield* drain(mutations);
      const second = master.startUtc + WEEK;
      yield* mutations.updateRecurring({
        ...target(master.id, second),
        changes: { title: `${master.title} (exception)` },
        scope: 'instance',
      });
      yield* drain(mutations);
      // Materialising the exception may have bumped the master's etag on
      // Google: refresh it so the rename is not a 412.
      yield* engine.syncAll();
      yield* mutations.updateRecurring({
        ...target(master.id, master.startUtc),
        changes: { title: `${master.title} (series)` },
        scope: 'series',
      });
      yield* drain(mutations);
      expect((yield* google.getEvent(calendar(), master.id)).summary).toBe(
        `${master.title} (series)`,
      );
      // Verified 2026-09-24: Google copies a master's new summary onto its
      // existing exceptions, overridden ones included (a title-only PATCH
      // of the master is enough). The exception keeps its own time.
      const instanceId = googleInstanceId(master.id, second, false);
      expect((yield* google.getEvent(calendar(), instanceId)).summary).toBe(
        `${master.title} (series)`,
      );
      // The app mirrored it on save — no pull needed — and the pull agrees.
      const events = yield* EventRepo;
      expect((yield* events.getById(LIVE_ACCOUNT_ID, calendar(), instanceId))?.title).toBe(
        `${master.title} (series)`,
      );
      yield* engine.syncAll();
      expect((yield* events.getById(LIVE_ACCOUNT_ID, calendar(), instanceId))?.title).toBe(
        `${master.title} (series)`,
      );
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );
});

const iso = (utc: number) => new Date(utc).toISOString();

/** The parts of a series with one moved and one cancelled occurrence the tests read. */
interface Series {
  /** The third occurrence's id: cancelled. */
  readonly cancelled: string;
  readonly masterId: string;
  /** The second occurrence's id: three hours later than its slot. */
  readonly moved: string;
  readonly movedSlot: number;
  readonly start: number;
}

/**
 * A series another device made: weekly, five occurrences, the second
 * moved three hours later, the third cancelled. UTC, as `createWeekly`.
 */
const seriesWithExceptions = (google: LiveScratchShape, name: string) =>
  Effect.gen(function* () {
    const start = hoursFromNow(2);
    const master = yield* google.insertEvent(calendar(), {
      end: { dateTime: iso(start + HOUR), timeZone: 'UTC' },
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=5'],
      start: { dateTime: iso(start), timeZone: 'UTC' },
      summary: titleFor(config, name),
    });
    const movedSlot = start + WEEK;
    const series: Series = {
      cancelled: googleInstanceId(master.id, start + 2 * WEEK, false),
      masterId: master.id,
      moved: googleInstanceId(master.id, movedSlot, false),
      movedSlot,
      start,
    };
    yield* google.patchEvent(calendar(), series.moved, {
      end: { dateTime: iso(movedSlot + 4 * HOUR), timeZone: 'UTC' },
      start: { dateTime: iso(movedSlot + 3 * HOUR), timeZone: 'UTC' },
    });
    yield* google.deleteEvent(calendar(), series.cancelled);
    return series;
  });

/** The same series made in the app, synced and pulled back. */
const appSeriesWithExceptions = (
  engine: { readonly syncAll: () => Effect.Effect<void> },
  mutations: Pick<
    EventMutationsShape,
    'createEvent' | 'deleteRecurring' | 'processPendingOps' | 'updateRecurring'
  >,
  name: string,
) =>
  Effect.gen(function* () {
    const master = yield* mutations.createEvent({
      accountId: LIVE_ACCOUNT_ID,
      calendarId: calendar(),
      endUtc: hoursFromNow(3),
      isAllDay: false,
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=5'],
      startTimeZone: 'UTC',
      startUtc: hoursFromNow(2),
      title: titleFor(config, name),
    });
    yield* drain(mutations);
    const movedSlot = master.startUtc + WEEK;
    const cancelledSlot = master.startUtc + 2 * WEEK;
    yield* mutations.updateRecurring({
      ...target(master.id, movedSlot),
      changes: { endUtc: movedSlot + 4 * HOUR, startUtc: movedSlot + 3 * HOUR },
      scope: 'instance',
    });
    yield* mutations.deleteRecurring({ ...target(master.id, cancelledSlot), scope: 'instance' });
    yield* drain(mutations);
    // The exceptions' etags, which the rule change's deletes would carry.
    yield* engine.syncAll();
    const series: Series = {
      cancelled: googleInstanceId(master.id, cancelledSlot, false),
      masterId: master.id,
      moved: googleInstanceId(master.id, movedSlot, false),
      movedSlot,
      start: master.startUtc,
    };
    return series;
  });

/** An event as Google has it: status and start. */
const stateOf = (google: LiveScratchShape, id: string) =>
  Effect.map(
    google.getEvent(calendar(), id),
    (event) => `${event.status} ${event.start?.dateTime ?? '-'}`,
  );

/** Each exception as Google has it. */
const onGoogle = (google: LiveScratchShape, series: Series) =>
  Effect.all({
    cancelled: stateOf(google, series.cancelled),
    moved: stateOf(google, series.moved),
  });

/** Where Google draws the series (`events.instances`, cancelled ones left out). */
const drawnOnGoogle = (google: LiveScratchShape, series: Series) =>
  Effect.map(google.listInstances(calendar(), series.masterId), (instances) =>
    instances.map((instance) => Date.parse(instance.start?.dateTime ?? '')).sort((a, b) => a - b),
  );

/** Where the calendar draws the series, over its first eight weeks. */
const drawnHere = (series: Series) =>
  Effect.gen(function* () {
    const events = yield* EventRepo;
    const from = series.start - HOUR;
    const to = series.start + 8 * WEEK;
    return assembleWindow(yield* events.getWindow(from, to), from, to)
      .filter((event) => event.recurringEventId === series.masterId)
      .map((event) => event.startUtc)
      .sort((a, b) => a - b);
  });

/** What the queue's own DELETE of an exception gets with `etag` as If-Match. */
const queueDelete = (eventId: string, baseEtag: string | undefined) =>
  Effect.gen(function* () {
    const client = yield* GoogleCalendarClient;
    return yield* client
      .deleteEvent({ accountId: LIVE_ACCOUNT_ID, baseEtag, calendarId: calendar(), eventId })
      .pipe(
        Effect.as('deleted'),
        Effect.catchTag('ConflictError', () => Effect.succeed('412')),
      );
  });

const etagOf = (google: LiveScratchShape, id: string) =>
  Effect.map(google.getEvent(calendar(), id), (event) => event.etag);

/**
 * Verified 2026-11-03: a PATCH of the master's `recurrence` keeps an
 * exception whose slot the new rule still draws exactly as it was (moved,
 * or cancelled) and cancels the others — past an UNTIL, skipped by the new
 * rule, or with no rule left. Every exception gets a new etag either way.
 * The queue follows: a rule change drops and deletes only the exceptions
 * the new rule skips, and the deletes a landed cut or rule change still
 * holds go with it.
 */
describe('live Google: a new rule and the series’ exceptions', () => {
  it.live('Google keeps the exceptions whose slots it still draws, with new etags', () =>
    Effect.gen(function* () {
      const { engine, scratch: google } = yield* bootstrap(config);
      const series = yield* seriesWithExceptions(google, 'rule-kept');
      const before = yield* onGoogle(google, series);
      const staleEtag = yield* etagOf(google, series.moved);
      yield* google.patchEvent(calendar(), series.masterId, {
        recurrence: ['RRULE:FREQ=WEEKLY;COUNT=12'],
      });
      expect(yield* onGoogle(google, series)).toEqual(before);
      expect(before.moved).toBe(
        `confirmed ${iso(series.movedSlot + 3 * HOUR).replace('.000', '')}`,
      );
      expect(before.cancelled.startsWith('cancelled')).toBe(true);
      // A queued delete from before the PATCH meets a 412, not the exception.
      expect(yield* etagOf(google, series.moved)).not.toBe(staleEtag);
      expect(yield* queueDelete(series.moved, staleEtag)).toBe('412');
      // The pull draws what Google draws.
      yield* engine.syncAll();
      const drawn = yield* drawnOnGoogle(google, series);
      expect(drawn).toContain(series.movedSlot + 3 * HOUR);
      expect(drawn).toHaveLength(11);
      expect(yield* drawnHere(series)).toEqual(drawn.filter((at) => at < series.start + 8 * WEEK));
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('a rule that skips them cancels them; one that draws them again brings slots back', () =>
    Effect.gen(function* () {
      const { engine, scratch: google } = yield* bootstrap(config);
      const series = yield* seriesWithExceptions(google, 'rule-skips');
      yield* engine.syncAll();
      yield* google.patchEvent(calendar(), series.masterId, {
        recurrence: ['RRULE:FREQ=WEEKLY;INTERVAL=3;COUNT=3'],
      });
      const skipped = yield* onGoogle(google, series);
      expect(skipped.moved.startsWith('cancelled')).toBe(true);
      expect(skipped.cancelled.startsWith('cancelled')).toBe(true);
      yield* engine.syncAll();
      expect(yield* drawnHere(series)).toEqual(yield* drawnOnGoogle(google, series));
      // Drawn again, both are plain occurrences at their slots: the move
      // and the cancellation are gone.
      yield* google.patchEvent(calendar(), series.masterId, {
        recurrence: ['RRULE:FREQ=WEEKLY;COUNT=5'],
      });
      expect((yield* onGoogle(google, series)).moved).toBe(
        `confirmed ${iso(series.movedSlot).replace('.000', '')}`,
      );
      expect((yield* onGoogle(google, series)).cancelled.startsWith('confirmed')).toBe(true);
      yield* engine.syncAll();
      const drawn = yield* drawnOnGoogle(google, series);
      expect(drawn).toEqual([0, 1, 2, 3, 4].map((week) => series.start + week * WEEK));
      expect(yield* drawnHere(series)).toEqual(drawn);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('an UNTIL before them, or no rule at all, cancels them too', () =>
    Effect.gen(function* () {
      const { scratch: google } = yield* bootstrap(config);
      const ended = yield* seriesWithExceptions(google, 'rule-until');
      yield* google.patchEvent(calendar(), ended.masterId, {
        recurrence: [`RRULE:FREQ=WEEKLY;UNTIL=${compactUtc(ended.start + DAY)}`],
      });
      const single = yield* seriesWithExceptions(google, 'rule-none');
      yield* google.patchEvent(calendar(), single.masterId, { recurrence: [] });
      for (const series of [ended, single]) {
        const state = yield* onGoogle(google, series);
        expect(state.moved.startsWith('cancelled')).toBe(true);
        expect(state.cancelled.startsWith('cancelled')).toBe(true);
      }
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('the app’s new rule keeps a moved and a cancelled occurrence it still draws', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const series = yield* appSeriesWithExceptions(engine, mutations, 'app-rule');
      const before = yield* onGoogle(google, series);
      const shownBefore = yield* drawnHere(series);
      // Before: its deletes went first and cancelled the moved occurrence.
      const queued = yield* noYield(
        Effect.gen(function* () {
          yield* mutations.updateRecurring({
            ...target(series.masterId, series.start),
            changes: { recurrence: ['RRULE:FREQ=WEEKLY;COUNT=12'] },
            scope: 'series',
          });
          return yield* pendingOps;
        }),
      );
      expect(queued.map((op) => op.kind)).toEqual(['update']);
      yield* drain(mutations);
      expect(yield* pendingOps).toEqual([]);
      expect(yield* onGoogle(google, series)).toEqual(before);
      const drawn = yield* drawnOnGoogle(google, series);
      expect(drawn).toHaveLength(11);
      const window = drawn.filter((at) => at < series.start + 8 * WEEK);
      expect(window.slice(0, shownBefore.length)).toEqual(shownBefore);
      expect(yield* drawnHere(series)).toEqual(window);
      yield* engine.syncAll();
      expect(yield* drawnHere(series)).toEqual(window);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('the app’s rule that skips them leaves nothing queued: the PATCH cancels them', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const series = yield* appSeriesWithExceptions(engine, mutations, 'app-skip');
      yield* mutations.updateRecurring({
        ...target(series.masterId, series.start),
        changes: { recurrence: ['RRULE:FREQ=WEEKLY;INTERVAL=3;COUNT=3'] },
        scope: 'series',
      });
      yield* drain(mutations);
      expect(yield* pendingOps).toEqual([]);
      const state = yield* onGoogle(google, series);
      expect(state.moved.startsWith('cancelled')).toBe(true);
      expect(state.cancelled.startsWith('cancelled')).toBe(true);
      const drawn = yield* drawnOnGoogle(google, series);
      expect(drawn).toEqual([0, 3, 6].map((week) => series.start + week * WEEK));
      expect(yield* drawnHere(series)).toEqual(drawn);
      yield* engine.syncAll();
      expect(yield* drawnHere(series)).toEqual(drawn);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('the app’s cut leaves nothing parked: Google cancels the exceptions past it', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const series = yield* appSeriesWithExceptions(engine, mutations, 'app-cut');
      yield* mutations.deleteRecurring({
        ...target(series.masterId, series.movedSlot),
        scope: 'following',
      });
      // Before: the moved occurrence's delete went after the truncation
      // with its old etag, met a 412 and parked as "changed on Google".
      yield* drain(mutations);
      expect(yield* pendingOps).toEqual([]);
      const state = yield* onGoogle(google, series);
      expect(state.moved.startsWith('cancelled')).toBe(true);
      expect(state.cancelled.startsWith('cancelled')).toBe(true);
      expect(yield* drawnOnGoogle(google, series)).toEqual([series.start]);
      expect(yield* drawnHere(series)).toEqual([series.start]);
      yield* engine.syncAll();
      expect(yield* drawnHere(series)).toEqual([series.start]);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );
});

/** A weekly series with its second occurrence moved, synced and pulled back. */
const seriesWithMoved = (
  engine: { readonly syncAll: () => Effect.Effect<void> },
  mutations: Pick<EventMutationsShape, 'createEvent' | 'processPendingOps' | 'updateRecurring'>,
  name: string,
) =>
  Effect.gen(function* () {
    const master = yield* createWeekly(mutations, name);
    yield* drain(mutations);
    const second = master.startUtc + WEEK;
    yield* mutations.updateRecurring({
      ...target(master.id, second),
      changes: { endUtc: second + 4 * HOUR, startUtc: second + 3 * HOUR },
      scope: 'instance',
    });
    yield* drain(mutations);
    yield* engine.syncAll();
    return { master, second };
  });

/**
 * A series PATCH gives the series' exceptions new etags (verified live
 * 2026-11-03): an occurrence op queued behind it carries the old etag and
 * meets a 412. Only the etag moved, so it goes again on Google's instead of
 * asking the user. An exception's own write leaves the master's etag alone:
 * a rename queued behind one meets no 412 at all.
 */
describe('live Google: an op queued behind a write that moved its etag', () => {
  it.live('an occurrence edit queued behind a series rename lands', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const { master, second } = yield* seriesWithMoved(engine, mutations, 'reetag-occurrence');
      const instanceId = googleInstanceId(master.id, second, false);
      yield* noYield(
        Effect.gen(function* () {
          yield* mutations.updateRecurring({
            ...target(master.id, master.startUtc),
            changes: { title: `${master.title} (renamed)` },
            scope: 'series',
          });
          yield* mutations.updateRecurring({
            ...target(master.id, second),
            changes: { location: 'Room 4' },
            scope: 'instance',
          });
        }),
      );
      yield* drain(mutations);
      expect(yield* pendingOps).toEqual([]);
      const exception = yield* google.getEvent(calendar(), instanceId);
      expect(exception.summary).toBe(`${master.title} (renamed)`);
      expect(exception.location).toBe('Room 4');
      expect(Date.parse(exception.start?.dateTime ?? '')).toBe(second + 3 * HOUR);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('a series rename queued behind an occurrence edit lands', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const { master, second } = yield* seriesWithMoved(engine, mutations, 'reetag-master');
      yield* noYield(
        Effect.gen(function* () {
          yield* mutations.updateRecurring({
            ...target(master.id, second),
            changes: { location: 'Room 4' },
            scope: 'instance',
          });
          yield* mutations.updateRecurring({
            ...target(master.id, master.startUtc),
            changes: { title: `${master.title} (renamed)` },
            scope: 'series',
          });
        }),
      );
      yield* drain(mutations);
      expect(yield* pendingOps).toEqual([]);
      expect((yield* google.getEvent(calendar(), master.id)).summary).toBe(
        `${master.title} (renamed)`,
      );
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );
});
