import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Field, FIELDS } from './check.ts';
import type { ModelCall } from './providers.ts';

/**
 * What one run leaves behind: a JSON report per provider under
 * `output/bench/` (the git sha, every turn's input, the model's raw
 * answers, the draft and what failed), a table on stdout, and the
 * difference to an earlier report when one is named. Two reports from two
 * commits are how a prompt or grounding change is judged.
 */

export interface TurnReport {
  /** A recorded turn: what became of its file. Absent for a text turn. */
  readonly audio?: 'failed' | 'missing' | 'skipped' | 'transcribed' | undefined;
  readonly calls: ReadonlyArray<ModelCall>;
  readonly checked: ReadonlyArray<Field>;
  readonly failed: ReadonlyArray<Field>;
  /** What the recogniser heard, when it ran. */
  readonly heard?: string | undefined;
  /** The words the parser got. */
  readonly input: string;
  /** The turn's model calls together; absent for a turn that never ran (no draft to change). */
  readonly ms?: number | undefined;
  readonly notes: ReadonlyArray<string>;
  /** The draft after the turn, or the rejection. */
  readonly outcome: unknown;
  /** The transcript's own parse, run when the recogniser erred and the turn failed: whose fault it was. */
  readonly said?: { readonly notes: ReadonlyArray<string>; readonly ok: boolean } | undefined;
  readonly wordErrorRate?: number | undefined;
}

export interface CaseReport {
  readonly id: string;
  readonly ok: boolean;
  readonly tags: ReadonlyArray<string>;
  readonly turns: ReadonlyArray<TurnReport>;
}

export interface Counter {
  readonly ok: number;
  readonly total: number;
}

export interface Score {
  readonly cases: Counter;
  /** Per field, over every turn that checked it. */
  readonly fields: Readonly<Partial<Record<Field, Counter>>>;
  /** Of a turn's model calls together. */
  readonly medianMs: number;
  /** Over the recorded turns: what became of each file, and the mean word error rate of the transcribed ones. */
  readonly recordings?:
    | {
        /** The recogniser could not read the file; the transcript ran. */
        readonly failed: number;
        readonly missing: number;
        readonly skipped: number;
        readonly transcribed: number;
        readonly wordErrorRate: number;
      }
    | undefined;
  readonly turns: Counter;
}

export interface BenchReport {
  readonly cases: ReadonlyArray<CaseReport>;
  readonly provider: string;
  readonly score: Score;
  readonly sha: string;
  readonly timeZone: string;
  readonly today: string;
  /** ISO time the run finished. */
  readonly when: string;
}

const median = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

export const scoreOf = (cases: ReadonlyArray<CaseReport>): Score => {
  const fields: Partial<Record<Field, { ok: number; total: number }>> = {};
  let turnsOk = 0;
  let turnsTotal = 0;
  const durations: Array<number> = [];
  const rates: Array<number> = [];
  const audio = { failed: 0, missing: 0, skipped: 0, transcribed: 0 };
  for (const benchCase of cases) {
    for (const turn of benchCase.turns) {
      turnsTotal += 1;
      turnsOk += turn.failed.length === 0 ? 1 : 0;
      if (turn.ms !== undefined) {
        durations.push(turn.ms);
      }
      if (turn.audio !== undefined) {
        audio[turn.audio] += 1;
      }
      if (turn.wordErrorRate !== undefined) {
        rates.push(turn.wordErrorRate);
      }
      for (const field of turn.checked) {
        const counter = fields[field] ?? { ok: 0, total: 0 };
        counter.total += 1;
        counter.ok += turn.failed.includes(field) ? 0 : 1;
        fields[field] = counter;
      }
    }
  }
  return {
    cases: { ok: cases.filter((benchCase) => benchCase.ok).length, total: cases.length },
    fields,
    medianMs: median(durations),
    recordings:
      audio.failed + audio.missing + audio.skipped + audio.transcribed === 0
        ? undefined
        : {
            ...audio,
            wordErrorRate:
              rates.length === 0 ? 0 : rates.reduce((sum, rate) => sum + rate, 0) / rates.length,
          },
    turns: { ok: turnsOk, total: turnsTotal },
  };
};

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const percent = (rate: number): string => `${String(Math.round(rate * 100))}%`;
const ratio = (counter: Counter): string => `${String(counter.ok)}/${String(counter.total)}`;

/** The run as a table: one line per case with its failing turns, then the score. */
export const formatReport = (report: BenchReport): string => {
  const lines: Array<string> = [`== ${report.provider}`];
  for (const benchCase of report.cases) {
    const total = benchCase.turns.reduce((sum, turn) => sum + (turn.ms ?? 0), 0);
    const details: Array<string> = [];
    for (const [index, turn] of benchCase.turns.entries()) {
      const label = benchCase.turns.length > 1 ? `[${String(index + 1)}] ` : '';
      if (turn.notes.length > 0) {
        details.push(`${label}${turn.notes.join(', ')}`);
      }
      if (
        turn.audio === 'transcribed' &&
        turn.wordErrorRate !== undefined &&
        turn.wordErrorRate > 0
      ) {
        details.push(
          `${label}heard "${turn.heard ?? ''}" (WER ${percent(turn.wordErrorRate)}${
            turn.said === undefined
              ? ''
              : turn.said.ok
                ? ', the transcript passes'
                : ', the transcript fails too'
          })`,
        );
      }
    }
    lines.push(
      `  ${benchCase.ok ? 'ok ' : '-- '} ${seconds(total).padStart(6)}  ${benchCase.id}${
        details.length === 0 ? '' : `  →  ${details.join(' · ')}`
      }`,
    );
  }
  const { score } = report;
  const fieldSummary = FIELDS.filter((field) => score.fields[field] !== undefined)
    .map((field) => `${field} ${ratio(score.fields[field]!)}`)
    .join(' · ');
  lines.push(
    '',
    `   cases ${ratio(score.cases)} · turns ${ratio(score.turns)} · median ${seconds(score.medianMs)} per turn`,
    `   ${fieldSummary}`,
  );
  if (score.recordings !== undefined) {
    const { failed, missing, skipped, transcribed, wordErrorRate } = score.recordings;
    lines.push(
      `   recordings: ${[
        transcribed === 0
          ? undefined
          : `${String(transcribed)} transcribed (WER ${percent(wordErrorRate)})`,
        failed === 0 ? undefined : `${String(failed)} failed to transcribe (ran as the transcript)`,
        missing === 0 ? undefined : `${String(missing)} missing (ran as the transcript)`,
        skipped === 0 ? undefined : `${String(skipped)} skipped (MODEL_BENCH_STT=off)`,
      ]
        .filter(Boolean)
        .join(', ')}`,
    );
  }
  return lines.join('\n');
};

/** The report as the before/after of a change: what moved, case by case and in the score. */
export const compareReports = (before: BenchReport, after: BenchReport): string => {
  const earlier = new Map(before.cases.map((benchCase) => [benchCase.id, benchCase]));
  const fixed: Array<string> = [];
  const broke: Array<string> = [];
  for (const benchCase of after.cases) {
    const previous = earlier.get(benchCase.id);
    if (previous === undefined || previous.ok === benchCase.ok) {
      continue;
    }
    (benchCase.ok ? fixed : broke).push(benchCase.id);
  }
  const moved = (field: Field): string | undefined => {
    const was = before.score.fields[field];
    const is = after.score.fields[field];
    return was === undefined || is === undefined || (was.ok === is.ok && was.total === is.total)
      ? undefined
      : `${field} ${ratio(was)} → ${ratio(is)}`;
  };
  return [
    `   vs ${before.sha} (${before.when.slice(0, 16)}): cases ${ratio(before.score.cases)} → ${ratio(
      after.score.cases,
    )}, turns ${ratio(before.score.turns)} → ${ratio(after.score.turns)}`,
    ...(fixed.length === 0 ? [] : [`   fixed: ${fixed.join(', ')}`]),
    ...(broke.length === 0 ? [] : [`   broke: ${broke.join(', ')}`]),
    ...FIELDS.map(moved)
      .filter((line): line is string => line !== undefined)
      .map((line) => `   ${line}`),
  ].join('\n');
};

const slug = (text: string): string =>
  text.replaceAll(/[^a-z0-9]+/gi, '-').replaceAll(/^-|-$/g, '');

/** Writes the report under `dir` and returns its path. */
export const writeReport = (dir: string, report: BenchReport): string => {
  mkdirSync(dir, { recursive: true });
  const stamp = report.when
    .slice(0, 19)
    .replaceAll(/[-:T]/g, '')
    .replace(/(\d{8})(\d{6})/, '$1-$2');
  const path = join(dir, `${stamp}-${report.sha}-${slug(report.provider)}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
};
