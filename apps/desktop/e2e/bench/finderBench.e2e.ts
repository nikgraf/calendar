import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFindTimePrompt, FIND_TIME_JSON_SCHEMA } from '@calendar/ai';
import { Temporal } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import {
  ARMS,
  FINDER_FIELDS,
  type FinderCase,
  type FinderCaseReport,
  type FinderReport,
  floorOf,
  loadFinderCases,
  readAnswer,
  rescoreFinder,
  scoreOf,
} from './finder.ts';
import { benchProviders, connectHelper, findHelper, gitSha, recording } from './providers.ts';

/**
 * The finder bench: find a time's sentences (`finder.json`) through the
 * app's finder prompt (`buildFindTimePrompt`, the schema the app sends) on
 * each model the MODEL_BENCH_* variables name, the answer read two ways:
 *
 * - `rules`: as the app reads it today, held to the words by the code
 *   (`normalizeFindTime` given the phrase: `grounding.ts`), the finder's own
 *   length where the words say none;
 * - `raw`: the model's answer without the word rules (`normalizeFindTime`
 *   without the phrase): what a model has to get right once the rules go.
 *   The code's defaults still fill what the model leaves out (the coming
 *   week for a window, as the prompt asks it to), and a case whose words
 *   give no length passes any: the schema has the model write one.
 *
 * Each part is scored (`finder.ts`): the length, the dates searched, the
 * daily bounds, what the time is for. Measured, never gated: it prints a
 * table, writes a report under output/bench/finder/ and passes.
 *
 *   MODEL_BENCH=1 E2E=1 pnpm exec vp test run apps/desktop/e2e/bench/finderBench.e2e.ts
 */

const TIME_ZONE = 'Europe/Vienna';
const BENCH_DIR = import.meta.dirname;
const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

const median = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

const formatReport = (report: FinderReport): string => {
  const { total } = report.score;
  const lines = [
    `== ${report.provider}${report.settings ? ` (${report.settings})` : ''}${
      report.rescored ? ` — the answers of ${report.rescored.sha}, ${report.rescored.when}` : ''
    }`,
    `   median ${(median(report.cases.map((each) => each.ms)) / 1000).toFixed(1)}s per phrase${
      report.floor
        ? ` · an empty answer: rules ${String(report.floor.rules)}, raw ${String(report.floor.raw)}`
        : ''
    }`,
  ];
  for (const arm of ARMS) {
    const score = report.score[arm];
    lines.push(
      `   ${arm.padEnd(5)}  cases ${String(score.cases)}/${String(total)} · ${FINDER_FIELDS.map(
        (field) => `${field} ${String(score.fields[field])}/${String(total)}`,
      ).join(' · ')}`,
    );
  }
  for (const each of report.cases) {
    const wrong = ARMS.filter((arm) => each.arms[arm].failed.length > 0);
    if (wrong.length === 0) {
      continue;
    }
    lines.push(`   ✗ ${each.id}  "${each.text}"`);
    for (const arm of wrong) {
      const { failed, got } = each.arms[arm];
      lines.push(`       ${arm}: ${failed.map((field) => `${field}=${got[field]}`).join(' · ')}`);
    }
  }
  return lines.join('\n');
};

const slug = (text: string): string => text.replaceAll(/[^\w.-]+/gu, '-').replaceAll(/^-|-$/gu, '');

const stampOf = (when: string): string =>
  when.replaceAll(/[-:]/gu, '').replace('T', '-').slice(0, 15);

const writeReport = (dir: string, report: FinderReport): string => {
  mkdirSync(dir, { recursive: true });
  const source = report.rescored
    ? `-of-${stampOf(report.rescored.when)}-${report.rescored.sha}`
    : '';
  const path = join(
    dir,
    `finder-${stampOf(report.when)}-${report.sha}-${slug(report.provider)}${source}.json`,
  );
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
};

/** The cases MODEL_BENCH_CASES names: a language ("de", "en"), or a part of an id. */
const selected = (cases: ReadonlyArray<FinderCase>): ReadonlyArray<FinderCase> => {
  const terms = (process.env['MODEL_BENCH_CASES'] ?? '')
    .split(',')
    .map((term) => term.trim())
    .filter(Boolean);
  return terms.length === 0
    ? cases
    : cases.filter((each) =>
        terms.some((term) =>
          term === 'de' || term === 'en' ? each.lang === term : each.id.includes(term),
        ),
      );
};

/** The finder reports MODEL_BENCH_RESCORE names: files, or every finder report in a folder. */
const reportsToRescore = (value: string): ReadonlyArray<string> =>
  value
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean)
    .flatMap((path) =>
      statSync(path).isDirectory()
        ? readdirSync(path)
            .filter((name) => name.startsWith('finder-') && name.endsWith('.json'))
            .sort()
            .map((name) => join(path, name))
        : [path],
    );

describe.skipIf(process.env['MODEL_BENCH'] !== '1')('finder bench', () => {
  it(
    'reads each finder phrase on each model, with and without the rules',
    { timeout: 120 * 60_000 },
    async () => {
      const today = Temporal.Now.plainDateISO(TIME_ZONE).toString();
      const sha = gitSha(ROOT);
      const lines: Array<string> = [`\nFINDER BENCH — today ${today}, ${TIME_ZONE}, ${sha}\n`];
      const log = (line: string) => {
        lines.push(line);
      };
      const cases = selected(loadFinderCases(join(BENCH_DIR, 'finder.json')));
      const helperBinary = findHelper();
      const helper = helperBinary === undefined ? undefined : connectHelper(helperBinary);
      // Beside, not among, the Assistant bench's reports: a folder of those is rescored as one.
      const outDir = join(
        process.env['MODEL_BENCH_OUT'] ?? join(ROOT, 'output', 'bench'),
        'finder',
      );
      const toRescore = process.env['MODEL_BENCH_RESCORE'];
      try {
        if (toRescore) {
          // Every case, whatever MODEL_BENCH_CASES says: a report is scored whole.
          const all = loadFinderCases(join(BENCH_DIR, 'finder.json'));
          for (const path of reportsToRescore(toRescore)) {
            const before = JSON.parse(readFileSync(path, 'utf8')) as FinderReport;
            const { left, report } = rescoreFinder(before, all, {
              sha,
              when: new Date().toISOString(),
            });
            log(formatReport(report));
            if (left.length > 0) {
              log(`   left out (gone, or other words now): ${left.join(', ')}`);
            }
            log(`   report: ${writeReport(outDir, report)}\n`);
          }
          return;
        }
        const available = await benchProviders(helper, log);
        if (available.length === 0) {
          log(
            'No model to bench: build the desktop helper (pnpm --filter @calendar/desktop build:helper), point MODEL_BENCH_HELPER at one, or name a served model (MODEL_BENCH_OLLAMA, MODEL_BENCH_OPENAI).',
          );
        }
        for (const provider of available) {
          // Recorded under any wrapper, so a report keeps what the model was sent and gave.
          const recorded = recording(provider.model);
          const model =
            provider.around === undefined ? recorded.model : provider.around(recorded.model);
          const reports: Array<FinderCaseReport> = [];
          for (const finderCase of cases) {
            const prompt = buildFindTimePrompt({
              phrase: finderCase.text,
              referenceDate: today,
              timeZone: TIME_ZONE,
            });
            const calls = recorded.begin();
            const started = Date.now();
            let read: unknown;
            let error: string | undefined;
            try {
              read = await model.generateJson({ jsonSchema: FIND_TIME_JSON_SCHEMA, prompt });
            } catch (error_) {
              error = error_ instanceof Error ? error_.message : String(error_);
            }
            const [call] = calls;
            const answer = call === undefined ? read : call.answer;
            reports.push({
              answer,
              arms: readAnswer(read, finderCase, today),
              ...(error === undefined ? {} : { error }),
              id: finderCase.id,
              lang: finderCase.lang,
              ms: Date.now() - started,
              prompt: call?.prompt ?? prompt,
              ...(provider.around === undefined ? {} : { read }),
              text: finderCase.text,
            });
          }
          const report: FinderReport = {
            cases: reports,
            floor: floorOf(cases, today),
            provider: provider.name,
            score: scoreOf(reports),
            settings: provider.settings,
            sha,
            timeZone: TIME_ZONE,
            today,
            when: new Date().toISOString(),
          };
          log(formatReport(report));
          log(`   report: ${writeReport(outDir, report)}\n`);
        }
      } finally {
        helper?.close();
        process.stdout.write(`${lines.join('\n')}\n`);
      }
      expect(cases.length).toBeGreaterThan(0);
    },
  );
});
