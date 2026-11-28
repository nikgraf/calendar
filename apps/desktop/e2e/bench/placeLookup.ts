import { makeFakeAppleCalendarClient } from '@calendar/apple-calendar';
import {
  Account,
  CalendarInfo,
  DEVICE_ZONE,
  EventRecord,
  GeoLocation,
  type PlaceCandidate,
} from '@calendar/core';
import { AccountRepo, CalendarRepo, EventRepo, reposLayer, runMigrations } from '@calendar/db';
import { GeoClient, geoClientFrom } from '@calendar/geo';
import { appleCalendarServicesLayer } from '@calendar/sync';
import { writeTimeZoneSettings } from '@calendar/sync/deviceSettings';
import { locationHandlers } from '@calendar/sync/locationHandlers';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { CITIES } from './places.ts';
import type { HelperClient } from './providers.ts';

/**
 * The app's own place lookup (`placeCandidates`) against MapKit, the
 * helper's, for both benches that ask it: the place bench (a place as
 * written, then with its other readings) and the model bench (the place a
 * draft names, when its case says which one is meant). The user's two
 * past events are in the city asked near, so nearby is where they are.
 *
 * MapKit throttles searches (about fifty a minute, then every one fails
 * for a while): a lookup waits until it fits in `CALLS_PER_MINUTE`, never
 * inside itself (its own timeouts would count the wait). A lookup one of
 * whose calls failed or gave no answer in time (the network gone for a
 * moment, the limit met by another run) is asked again after a pause, a
 * few times; what its last try could not reach is its to report.
 */

const CALLS_PER_MINUTE = 40;
/** MapKit calls one lookup makes at most: a search, the completer and its five rows, four readings. */
const CALLS_PER_LOOKUP = 11;
const MINUTE_MS = 60_000;
/** A lookup MapKit let down is asked this often in all, this long apart. */
const LOOKUP_TRIES = 3;
const RETRY_PAUSE_MS = 30_000;

/**
 * A lookup asked again while its calls fail: the first answer without a
 * failed call, or the last try's with what failed in it.
 */
export const askAgain = async <Answer extends { readonly failures: ReadonlyArray<string> }>(
  ask: () => Promise<Answer>,
  {
    pause = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    tries = LOOKUP_TRIES,
  }: {
    readonly pause?: (ms: number) => Promise<void>;
    readonly tries?: number;
  } = {},
): Promise<Answer> => {
  for (let tried = 1; ; tried += 1) {
    const answer = await ask();
    if (answer.failures.length === 0 || tried >= tries) {
      return answer;
    }
    await pause(RETRY_PAUSE_MS);
  }
};

export interface PlaceLookup {
  /** The candidates for a place as a draft names it, and the MapKit calls of this lookup that failed or gave no answer in time. */
  readonly ask: (
    near: string,
    payload: Parameters<typeof locationHandlers.placeCandidates>[0],
  ) => Promise<{
    readonly candidates: ReadonlyArray<PlaceCandidate>;
    readonly failures: ReadonlyArray<string>;
  }>;
}

/** The app's stores in memory, the user's two past events in the city, MapKit the helper's. */
const layerFor = (near: string, client: ReturnType<typeof geoClientFrom>) => {
  const city = CITIES[near];
  if (city === undefined) {
    throw new Error(`no city "${near}": ${Object.keys(CITIES).join(', ')}`);
  }
  const placed = (id: string, daysAgo: number) =>
    new EventRecord({
      accountId: 'acc',
      calendarId: 'cal',
      endUtc: Date.now() - daysAgo * 86_400_000 + 3_600_000,
      etag: `"${id}"`,
      geo: new GeoLocation({ lat: city.lat, lng: city.lng, source: id }),
      id,
      isAllDay: false,
      location: id,
      startTimeZone: city.timeZone,
      startUtc: Date.now() - daysAgo * 86_400_000,
      status: 'confirmed',
      syncedAt: 1,
      syncStatus: 'synced',
      title: id,
      updatedAt: 1,
    });
  const seed = Effect.gen(function* () {
    yield* writeTimeZoneSettings({ primary: city.timeZone, zones: [DEVICE_ZONE, city.timeZone] });
    yield* (yield* AccountRepo).upsert(
      new Account({
        contactsEnabled: false,
        createdAt: 1,
        email: 'bench@example.com',
        id: 'acc',
        provider: 'google',
        status: 'ok',
        tasksEnabled: false,
      }),
    );
    yield* (yield* CalendarRepo).upsertMany([
      new CalendarInfo({
        accessRole: 'owner',
        accountId: 'acc',
        colorHex: '#4285f4',
        id: 'cal',
        isPrimary: true,
        isVisible: true,
        provider: 'google',
        summary: 'Bench',
        timeZone: city.timeZone,
      }),
    ]);
    yield* (yield* EventRepo).upsertMany([placed('home', 1), placed('work', 2)]);
  });
  return Layer.mergeAll(
    Layer.succeed(GeoClient, client),
    Layer.effectDiscard(seed).pipe(
      Layer.provideMerge(
        appleCalendarServicesLayer(makeFakeAppleCalendarClient().client).pipe(
          Layer.provideMerge(reposLayer),
          Layer.provideMerge(Layer.effectDiscard(runMigrations)),
          Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
          Layer.provideMerge(reactivityLayer),
        ),
      ),
    ),
  );
};

/**
 * MapKit over the helper, its calls counted, each kept with the lookup
 * that made it: a call that failed, or had not answered when its lookup
 * did (the lookup's own timeout let it go), is that lookup's to report.
 */
export const placeLookup = (helper: HelperClient): PlaceLookup => {
  const started: Array<number> = [];
  const calls: Array<{
    error?: string;
    /** The lookup that made it, by its turn: a place asked twice is two lookups. */
    readonly lookup: number;
    readonly method: string;
    settled: boolean;
  }> = [];
  let current = 0;
  const client = geoClientFrom({
    invoke: async (method, params) => {
      started.push(Date.now());
      const call: (typeof calls)[number] = { lookup: current, method, settled: false };
      calls.push(call);
      try {
        return await helper.request(method, params ?? {});
      } catch (error) {
        call.error = `${method}: ${error instanceof Error ? error.message : String(error)}`;
        throw error;
      } finally {
        call.settled = true;
      }
    },
    subscribe: () => () => {},
  });
  /** Waits until a whole lookup fits in the last minute's calls. */
  const room = async () => {
    for (;;) {
      const now = Date.now();
      const recent = started.filter((at) => now - at < MINUTE_MS);
      if (recent.length + CALLS_PER_LOOKUP <= CALLS_PER_MINUTE) {
        return;
      }
      const oldest = recent[0] ?? now;
      await new Promise((resolve) => setTimeout(resolve, oldest + MINUTE_MS - now + 50));
    }
  };
  const once = async (
    near: string,
    payload: Parameters<typeof locationHandlers.placeCandidates>[0],
  ) => {
    await room();
    current += 1;
    const mine = current;
    const candidates = await Effect.runPromise(
      locationHandlers.placeCandidates(payload).pipe(Effect.provide(layerFor(near, client))),
    );
    return {
      candidates,
      failures: calls
        .filter((call) => call.lookup === mine)
        .flatMap((call) =>
          call.error !== undefined
            ? [call.error]
            : call.settled
              ? []
              : [`${call.method}: no answer in time`],
        ),
    };
  };
  return { ask: (near, payload) => askAgain(() => once(near, payload)) };
};
