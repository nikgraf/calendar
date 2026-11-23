import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alternativesFor, heardFromSegments, readingsFor } from '@calendar/ai';
import {
  Account,
  CalendarInfo,
  DEVICE_ZONE,
  EventRecord,
  GeoLocation,
  type PlaceCandidate,
} from '@calendar/core';
import { AccountRepo, CalendarRepo, EventRepo, reposLayer, runMigrations } from '@calendar/db';
import { makeFakeAppleCalendarClient } from '@calendar/apple-calendar';
import { GeoClient, geoClientFrom } from '@calendar/geo';
import { appleCalendarServicesLayer } from '@calendar/sync';
import { writeTimeZoneSettings } from '@calendar/sync/deviceSettings';
import { locationHandlers } from '@calendar/sync/locationHandlers';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { describe, expect, it } from 'vite-plus/test';
import {
  CITIES,
  formatPlaceReport,
  loadPlaceCases,
  outcomeOf,
  type PlaceCase,
  type PlaceCaseReport,
  type PlaceReport,
} from './places.ts';
import { connectHelper, findHelper, gitSha, type HelperClient } from './providers.ts';

/**
 * The place bench: each case of `places.json` — a phrase naming a place,
 * as a recogniser read it, with the other readings it weighed — through
 * the app's own place lookup (`placeCandidates`) against MapKit, the
 * helper's: the place as written, then with dictation's other readings
 * of it (`readingsFor`; the recogniser's own alone, `alternativesFor`,
 * under PLACE_BENCH_OTHER=off), as a dictated turn asks. The user's two past
 * events are in the case's city, so nearby is where they are. Measured,
 * never gated: it prints a table, writes a report under
 * output/bench/places/ and passes.
 *
 * MapKit throttles searches (about fifty a minute, then every one fails
 * for a while): the bench keeps to `CALLS_PER_MINUTE`, waiting between
 * lookups, never inside one (the lookup's own timeouts would count the
 * wait).
 *
 *   MODEL_BENCH=1 E2E=1 pnpm exec vp test run apps/desktop/e2e/bench/placeBench.e2e.ts
 */

const BENCH_DIR = import.meta.dirname;
const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const CALLS_PER_MINUTE = 40;
/** MapKit calls one lookup makes at most: a search, the completer and its five rows, four readings. */
const CALLS_PER_LOOKUP = 11;
const MINUTE_MS = 60_000;

/**
 * MapKit over the helper, its calls counted, each kept with the lookup
 * that made it: a call that failed, or had not answered when its lookup
 * did (the lookup's own timeout let it go), is that lookup's to report.
 */
const mapkit = (helper: HelperClient) => {
  const started: Array<number> = [];
  const calls: Array<{
    error?: string;
    readonly lookup: string;
    readonly method: string;
    settled: boolean;
  }> = [];
  let current = '';
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
  return {
    client,
    /** The calls the lookup made that failed or gave no answer in time. */
    failures: (lookup: string): ReadonlyArray<string> =>
      calls
        .filter((call) => call.lookup === lookup)
        .flatMap((call) =>
          call.error !== undefined
            ? [call.error]
            : call.settled
              ? []
              : [`${call.method}: no answer in time`],
        ),
    /** Names the lookup the calls from now on belong to. */
    lookup: (name: string) => {
      current = name;
    },
    /** Waits until a whole lookup fits in the last minute's calls. */
    room: async () => {
      for (;;) {
        const now = Date.now();
        const recent = started.filter((at) => now - at < MINUTE_MS);
        if (recent.length + CALLS_PER_LOOKUP <= CALLS_PER_MINUTE) {
          return;
        }
        const oldest = recent[0] ?? now;
        await new Promise((resolve) => setTimeout(resolve, oldest + MINUTE_MS - now + 50));
      }
    },
  };
};

/** The app's stores in memory, the user's two past events in the case's city, MapKit the helper's. */
const layerFor = (each: PlaceCase, client: ReturnType<typeof mapkit>['client']) => {
  const city = CITIES[each.near]!;
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

/** The cases MODEL_BENCH_CASES names by a part of their id. */
const selected = (cases: ReadonlyArray<PlaceCase>): ReadonlyArray<PlaceCase> => {
  const terms = (process.env['MODEL_BENCH_CASES'] ?? '')
    .split(',')
    .map((term) => term.trim())
    .filter(Boolean);
  return terms.length === 0
    ? cases
    : cases.filter((each) => terms.some((term) => each.id.includes(term)));
};

const stampOf = (when: string): string =>
  when.replaceAll(/[-:]/gu, '').replace('T', '-').slice(0, 15);

describe.skipIf(process.env['MODEL_BENCH'] !== '1')('place bench', () => {
  it(
    'asks MapKit for each dictated place as written, then with its other readings',
    { timeout: 120 * 60_000 },
    async () => {
      const sha = gitSha(ROOT);
      const lines: Array<string> = [`\nPLACE BENCH — ${sha}\n`];
      const cases = selected(loadPlaceCases(join(BENCH_DIR, 'places.json')));
      const binary = findHelper();
      if (binary === undefined) {
        process.stdout.write(
          'No helper for MapKit: build it (pnpm --filter @calendar/desktop build:helper) or point MODEL_BENCH_HELPER at one.\n',
        );
        return;
      }
      const helper = connectHelper(binary);
      const geo = mapkit(helper);
      const reports: Array<PlaceCaseReport> = [];
      try {
        for (const each of cases) {
          // PLACE_BENCH_OTHER=off: the recogniser's own readings alone, without the other language's.
          const both = process.env['PLACE_BENCH_OTHER'] !== 'off';
          const heard = heardFromSegments(each.heard, both ? each.other : undefined);
          const alternatives =
            heard === undefined ? [] : (both ? readingsFor : alternativesFor)(heard, each.location);
          const ask = async (
            arm: string,
            payload: Parameters<typeof locationHandlers.placeCandidates>[0],
          ) => {
            await geo.room();
            const name = `${each.id}:${arm}`;
            geo.lookup(name);
            const candidates: ReadonlyArray<PlaceCandidate> = await Effect.runPromise(
              locationHandlers
                .placeCandidates(payload)
                .pipe(Effect.provide(layerFor(each, geo.client))),
            );
            return outcomeOf(candidates, each.names, geo.failures(name));
          };
          const asWritten = await ask('as-written', { location: each.location });
          const readings = await ask('readings', {
            ...(alternatives.length > 0 ? { alternatives } : {}),
            location: each.location,
          });
          reports.push({
            alternatives,
            asWritten,
            id: each.id,
            location: each.location,
            readings,
            said: each.said,
            voice: each.voice,
          });
        }
      } finally {
        helper.close();
      }
      const report: PlaceReport = { cases: reports, sha, when: new Date().toISOString() };
      const dir = join(process.env['MODEL_BENCH_OUT'] ?? join(ROOT, 'output', 'bench'), 'places');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `places-${stampOf(report.when)}-${sha}.json`);
      writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
      lines.push(formatPlaceReport(report), `   report: ${path}\n`);
      process.stdout.write(`${lines.join('\n')}\n`);
      expect(reports.length).toBe(cases.length);
    },
  );
});
