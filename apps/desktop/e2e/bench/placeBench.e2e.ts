import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alternativesFor, heardFromSegments, readingsFor } from '@calendar/ai';
import type { locationHandlers } from '@calendar/sync/locationHandlers';
import { describe, expect, it } from 'vite-plus/test';
import { placeLookup } from './placeLookup.ts';
import {
  formatPlaceReport,
  loadPlaceCases,
  outcomeOf,
  type PlaceCase,
  type PlaceCaseReport,
  type PlaceReport,
} from './places.ts';
import { connectHelper, findHelper, gitSha } from './providers.ts';

/**
 * The place bench: each case of `places.json` — a phrase naming a place,
 * as a recogniser read it, with the other readings it weighed — through
 * the app's own place lookup (`placeCandidates`) against MapKit, the
 * helper's: the place as written, then with dictation's other readings
 * of it (`readingsFor`; the recogniser's own alone, `alternativesFor`,
 * under PLACE_BENCH_OTHER=off), as a dictated turn asks. The user's two past
 * events are in the case's city, so nearby is where they are. Measured,
 * never gated: it prints a table, writes a report under
 * output/bench/places/ and passes. The lookup, and how it keeps to
 * MapKit's limit, is `placeLookup.ts`.
 *
 *   MODEL_BENCH=1 E2E=1 pnpm exec vp test run apps/desktop/e2e/bench/placeBench.e2e.ts
 */

const BENCH_DIR = import.meta.dirname;
const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
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
      const places = placeLookup(helper);
      const reports: Array<PlaceCaseReport> = [];
      try {
        for (const each of cases) {
          // PLACE_BENCH_OTHER=off: the recogniser's own readings alone, without the other language's.
          const both = process.env['PLACE_BENCH_OTHER'] !== 'off';
          const heard = heardFromSegments(each.heard, both ? each.other : undefined);
          const alternatives =
            heard === undefined ? [] : (both ? readingsFor : alternativesFor)(heard, each.location);
          const ask = async (payload: Parameters<typeof locationHandlers.placeCandidates>[0]) => {
            const { candidates, failures } = await places.ask(each.near, payload);
            return outcomeOf(candidates, each.names, failures);
          };
          const asWritten = await ask({ location: each.location });
          const readings = await ask({
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
