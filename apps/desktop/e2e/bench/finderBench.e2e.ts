import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFindTimePrompt, buildTunedFinderPrompt, FIND_TIME_JSON_SCHEMA } from '@calendar/ai';
import { Temporal } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import {
  compareFinderReports,
  FINDER_PIPELINES,
  type FinderCase,
  type FinderCaseReport,
  type FinderPipeline,
  type FinderReport,
  floorOf,
  formatFinderReport,
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
 * MODEL_BENCH_PIPELINE=tuned asks the Assistant's own model instead:
 * its prompt (`buildTunedFinderPrompt`), no schema; the app reads its
 * answer as the `raw` arm does, a length left out where none was said.
 *
 *   MODEL_BENCH=1 E2E=1 pnpm exec vp test run apps/desktop/e2e/bench/finderBench.e2e.ts
 */

const TIME_ZONE = 'Europe/Vienna';
const BENCH_DIR = import.meta.dirname;
const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

/** How the models are asked, per MODEL_BENCH_PIPELINE: the app's finder prompt unless it says `tuned`. */
const pipelineOf = (): FinderPipeline => {
  const asked = (process.env['MODEL_BENCH_PIPELINE'] ?? '').trim();
  if (asked === '') {
    return 'app';
  }
  const known = FINDER_PIPELINES.find((pipeline) => pipeline === asked);
  if (known === undefined) {
    throw new Error(
      `MODEL_BENCH_PIPELINE names no finder pipeline "${asked}": ${FINDER_PIPELINES.join(', ')}`,
    );
  }
  return known;
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
    `finder-${stampOf(report.when)}-${report.sha}-${slug(report.provider)}${report.pipeline === 'tuned' ? '-tuned' : ''}${source}.json`,
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
      const pipeline = pipelineOf();
      const helperBinary = findHelper();
      const helper = helperBinary === undefined ? undefined : connectHelper(helperBinary);
      // Beside, not among, the Assistant bench's reports: a folder of those is rescored as one.
      const outDir = join(
        process.env['MODEL_BENCH_OUT'] ?? join(ROOT, 'output', 'bench'),
        'finder',
      );
      const toRescore = process.env['MODEL_BENCH_RESCORE'];
      // Blind cases are counted, never named, unless an expectation is being fixed.
      const table = { showBlind: process.env['MODEL_BENCH_BLIND'] === 'show' };
      const compareWith = process.env['MODEL_BENCH_COMPARE'];
      const earlier =
        compareWith === undefined
          ? undefined
          : (JSON.parse(readFileSync(compareWith, 'utf8')) as FinderReport);
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
            log(formatFinderReport(report, table));
            log(compareFinderReports(before, report, table));
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
            const prompt =
              pipeline === 'tuned'
                ? buildTunedFinderPrompt({ phrase: finderCase.text, referenceDate: today })
                : buildFindTimePrompt({
                    phrase: finderCase.text,
                    referenceDate: today,
                    timeZone: TIME_ZONE,
                  });
            const calls = recorded.begin();
            const started = Date.now();
            let read: unknown;
            let error: string | undefined;
            try {
              read = await model.generateJson({
                jsonSchema: pipeline === 'tuned' ? undefined : FIND_TIME_JSON_SCHEMA,
                prompt,
              });
            } catch (error_) {
              error = error_ instanceof Error ? error_.message : String(error_);
            }
            const [call] = calls;
            const answer = call === undefined ? read : call.answer;
            reports.push({
              answer,
              arms: readAnswer(read, finderCase, today, { pipeline }),
              blind: finderCase.blind === true,
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
            pipeline,
            provider: provider.name,
            score: scoreOf(reports),
            settings: provider.settings,
            sha,
            timeZone: TIME_ZONE,
            today,
            when: new Date().toISOString(),
          };
          log(formatFinderReport(report, table));
          if (earlier !== undefined && earlier.provider === provider.name) {
            log(compareFinderReports(earlier, report, table));
          } else if (earlier !== undefined) {
            log(`   (MODEL_BENCH_COMPARE is a ${earlier.provider} report; not compared)`);
          }
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
