import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFindTimePrompt,
  FIND_TIME_JSON_SCHEMA,
  type FindTimeParse,
  type FindTimeResult,
  normalizeFindTime,
} from '@calendar/ai';
import { Temporal } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import {
  checkFinder,
  FALLBACK_MINUTES,
  FINDER_FIELDS,
  type FinderCase,
  type FinderField,
  type FinderGot,
  loadFinderCases,
} from './finder.ts';
import { benchProviders, connectHelper, findHelper, gitSha } from './providers.ts';

/**
 * The finder bench: find a time's sentences (`finder.json`) through the
 * app's finder prompt (`buildFindTimePrompt`, the schema the app sends) on
 * each model the MODEL_BENCH_* variables name, the answer read two ways:
 *
 * - `rules`: as the app reads it today, held to the words by the code
 *   (`normalizeFindTime` given the phrase: `grounding.ts`), the finder's own
 *   length where the words say none;
 * - `raw`: the model's answer alone (`normalizeFindTime` without the
 *   phrase): what a model has to get right once the rules go.
 *
 * Each part is scored (`finder.ts`): the length, the dates searched, the
 * daily bounds, what the time is for. Measured, never gated: it prints a
 * table, writes a report under output/bench/ and passes.
 *
 *   MODEL_BENCH=1 E2E=1 pnpm exec vp test run apps/desktop/e2e/bench/finderBench.e2e.ts
 */

const TIME_ZONE = 'Europe/Vienna';
const BENCH_DIR = import.meta.dirname;
const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

const ARMS = ['rules', 'raw'] as const;
type Arm = (typeof ARMS)[number];

interface ArmResult {
  readonly failed: ReadonlyArray<FinderField>;
  readonly got: FinderGot;
}

interface FinderCaseReport {
  /** The model's answer as it came. */
  readonly answer: unknown;
  readonly arms: Readonly<Record<Arm, ArmResult>>;
  readonly error?: string | undefined;
  readonly id: string;
  readonly lang: string;
  readonly ms: number;
  readonly prompt: string;
  readonly text: string;
}

interface ArmScore {
  readonly cases: number;
  readonly fields: Readonly<Record<FinderField, number>>;
}

interface FinderReport {
  readonly cases: ReadonlyArray<FinderCaseReport>;
  readonly provider: string;
  readonly score: Readonly<Record<Arm, ArmScore>> & { readonly total: number };
  readonly settings?: string | undefined;
  readonly sha: string;
  readonly timeZone: string;
  readonly today: string;
  readonly when: string;
}

const NO_ANSWER: FindTimeResult = { kind: 'rejected', reason: 'the model gave no answer' };

/** One answer, read by each arm. */
const readAnswer = (
  answer: unknown,
  finderCase: FinderCase,
  today: string,
): Record<Arm, ArmResult> => {
  const parse =
    typeof answer === 'object' && answer !== null ? (answer as FindTimeParse) : undefined;
  const read = (arm: Arm): FindTimeResult =>
    parse === undefined
      ? NO_ANSWER
      : normalizeFindTime(
          parse,
          arm === 'rules'
            ? {
                fallbackDurationMinutes: FALLBACK_MINUTES,
                phrase: finderCase.text,
                referenceDate: today,
              }
            : { referenceDate: today },
        );
  return {
    raw: checkFinder(finderCase.expect, read('raw'), today),
    rules: checkFinder(finderCase.expect, read('rules'), today),
  };
};

const scoreOf = (cases: ReadonlyArray<FinderCaseReport>): FinderReport['score'] => {
  const arm = (name: Arm): ArmScore => ({
    cases: cases.filter((each) => each.arms[name].failed.length === 0).length,
    fields: Object.fromEntries(
      FINDER_FIELDS.map((field) => [
        field,
        cases.filter((each) => !each.arms[name].failed.includes(field)).length,
      ]),
    ) as Record<FinderField, number>,
  });
  return { raw: arm('raw'), rules: arm('rules'), total: cases.length };
};

const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : (sorted[Math.floor(sorted.length / 2)] ?? 0);
};

const formatReport = (report: FinderReport): string => {
  const { total } = report.score;
  const lines = [
    `== ${report.provider}${report.settings ? ` (${report.settings})` : ''}`,
    `   median ${(median(report.cases.map((each) => each.ms)) / 1000).toFixed(1)}s per phrase`,
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

const writeReport = (dir: string, report: FinderReport): string => {
  mkdirSync(dir, { recursive: true });
  const stamp = report.when.replaceAll(/[-:]/gu, '').replace('T', '-').slice(0, 15);
  const path = join(dir, `finder-${stamp}-${report.sha}-${slug(report.provider)}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
};

/** The cases MODEL_BENCH_CASES names: a part of an id, or a language ("de"). */
const selected = (cases: ReadonlyArray<FinderCase>): ReadonlyArray<FinderCase> => {
  const terms = (process.env['MODEL_BENCH_CASES'] ?? '')
    .split(',')
    .map((term) => term.trim())
    .filter(Boolean);
  return terms.length === 0
    ? cases
    : cases.filter((each) => terms.some((term) => each.id.includes(term) || each.lang === term));
};

describe.skipIf(process.env['MODEL_BENCH'] !== '1')('finder bench', () => {
  it(
    'reads each finder phrase on each model, with and without the rules',
    { timeout: 60 * 60_000 },
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
      const outDir = process.env['MODEL_BENCH_OUT'] ?? join(ROOT, 'output', 'bench');
      try {
        const available = await benchProviders(helper, log);
        if (available.length === 0) {
          log(
            'No model to bench: build the desktop helper (pnpm --filter @calendar/desktop build:helper), point MODEL_BENCH_HELPER at one, or name a served model (MODEL_BENCH_OLLAMA, MODEL_BENCH_OPENAI).',
          );
        }
        for (const provider of available) {
          const model =
            provider.around === undefined ? provider.model : provider.around(provider.model);
          const reports: Array<FinderCaseReport> = [];
          for (const finderCase of cases) {
            const prompt = buildFindTimePrompt({
              phrase: finderCase.text,
              referenceDate: today,
              timeZone: TIME_ZONE,
            });
            const started = Date.now();
            let answer: unknown;
            let error: string | undefined;
            try {
              answer = await model.generateJson({ jsonSchema: FIND_TIME_JSON_SCHEMA, prompt });
            } catch (error_) {
              error = error_ instanceof Error ? error_.message : String(error_);
            }
            reports.push({
              answer,
              arms: readAnswer(answer, finderCase, today),
              ...(error === undefined ? {} : { error }),
              id: finderCase.id,
              lang: finderCase.lang,
              ms: Date.now() - started,
              prompt,
              text: finderCase.text,
            });
          }
          const report: FinderReport = {
            cases: reports,
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
