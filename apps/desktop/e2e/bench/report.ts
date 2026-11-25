import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Field, FIELDS, placeFound } from './check.ts';
import { type Flip, flipLines, namedCases } from './flips.ts';
import type { ParakeetReading } from './listening.ts';
import type { PlaceOutcome } from './places.ts';
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
  /**
   * A heard turn's other readings, beside `heard` (the words that were
   * sent): Apple's recogniser's when Parakeet's were sent, the second
   * language's, and Parakeet's own account (its words before the names
   * it listens for, and what they replaced).
   */
  readonly readings?:
    | {
        readonly apple?: string | undefined;
        readonly other?: string | undefined;
        readonly parakeet?: ParakeetReading | undefined;
      }
    | undefined;
  /**
   * The transcript's own parse, run when the recogniser erred and the turn
   * failed: whose fault it was. Its outcome is kept, so the verdict can be
   * scored again with the turn's (`rescore.ts`).
   */
  readonly said?:
    | {
        readonly notes: ReadonlyArray<string>;
        readonly ok: boolean;
        readonly outcome?: unknown;
      }
    | undefined;
  readonly wordErrorRate?: number | undefined;
}

export interface CaseReport {
  /**
   * A blind case (`cases.ts`): counted in every score, named in no table.
   * Absent in reports from before there were any.
   */
  readonly blind?: boolean | undefined;
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
  /**
   * Over the turns whose place the run asked MapKit for: taken unasked,
   * offered to pick, right by its text alone, or missed. Absent where
   * none was asked.
   */
  readonly places?: PlaceTally | undefined;
  /** Over the recorded turns: what became of each file, and the mean word error rate of the transcribed ones. */
  readonly recordings?:
    | {
        /** The recogniser could not read the file; the transcript ran. */
        readonly failed: number;
        /**
         * Of the transcribed turns, where each failing one was lost: to the
         * hearing (the words as said pass), or after it (they fail too, or
         * were heard word for word). `unjudged`: misheard and failing, its
         * words as said never read (a turn that passed when it ran and
         * fails a rescore). Absent in reports from before it was counted.
         */
        readonly heard?:
          | {
              readonly lostAfter: number;
              readonly lostHearing: number;
              readonly ok: number;
              readonly unjudged: number;
            }
          | undefined;
        readonly missing: number;
        readonly skipped: number;
        readonly transcribed: number;
        readonly wordErrorRate: number;
      }
    | undefined;
  readonly turns: Counter;
}

export interface PlaceTally {
  readonly asked: number;
  /** A MapKit call of the lookup failed or gave no answer in time: a miss may be that. */
  readonly errors: number;
  readonly missed: number;
  /** Among the places to pick from, not taken. */
  readonly offered: number;
  readonly taken: number;
  /** Not found by the lookup, the text names it all the same. */
  readonly text: number;
}

/**
 * Where a heard turn stands. A failing one was lost to the hearing when
 * its words as said pass, and after it when they fail too or were heard
 * word for word (the turn's own failure is theirs). One that was misheard
 * and has no reading of its words as said is not judged: a run reads them
 * for every such turn, a rescore only where the run did.
 */
const heardWhere = (turn: TurnReport): 'lostAfter' | 'lostHearing' | 'ok' | 'unjudged' => {
  if (turn.failed.length === 0) {
    return 'ok';
  }
  if (turn.said !== undefined) {
    return turn.said.ok ? 'lostHearing' : 'lostAfter';
  }
  return turn.wordErrorRate === 0 ? 'lostAfter' : 'unjudged';
};

/** What the run's place lookup made of a turn's location, as its stored outcome holds it. */
const placeOf = (turn: TurnReport): PlaceOutcome | undefined =>
  (turn.outcome as { readonly draft?: { readonly place?: PlaceOutcome } } | null | undefined)?.draft
    ?.place;

export interface BenchReport {
  readonly cases: ReadonlyArray<CaseReport>;
  readonly provider: string;
  /**
   * The run this report was scored again from (`rescore.ts`), however
   * often: its commit and its time. `stale` names the cases the scoring
   * left as the report had them, because the case is gone or has other
   * turns or words than the model answered.
   */
  readonly rescored?:
    | {
        readonly sha: string;
        readonly stale?: ReadonlyArray<string> | undefined;
        readonly when: string;
      }
    | undefined;
  readonly score: Score;
  /**
   * What the run set that the provider's name does not say: a served
   * model's endpoint and MODEL_BENCH_OPENAI_EXTRA. Two reports of one name
   * with other settings are two results.
   */
  readonly settings?: string | undefined;
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
  const heard = { lostAfter: 0, lostHearing: 0, ok: 0, unjudged: 0 };
  const places = { asked: 0, errors: 0, missed: 0, offered: 0, taken: 0, text: 0 };
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
      if (turn.audio === 'transcribed') {
        heard[heardWhere(turn)] += 1;
      }
      const place = placeOf(turn);
      if (place !== undefined) {
        places.asked += 1;
        places.errors += place.errors.length > 0 ? 1 : 0;
        const how = place.taken
          ? 'taken'
          : placeFound(place)
            ? 'offered'
            : turn.failed.includes('location')
              ? 'missed'
              : 'text';
        places[how] += 1;
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
    places: places.asked === 0 ? undefined : places,
    recordings:
      audio.failed + audio.missing + audio.skipped + audio.transcribed === 0
        ? undefined
        : {
            ...audio,
            heard: audio.transcribed === 0 ? undefined : heard,
            wordErrorRate:
              rates.length === 0 ? 0 : rates.reduce((sum, rate) => sum + rate, 0) / rates.length,
          },
    turns: { ok: turnsOk, total: turnsTotal },
  };
};

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const percent = (rate: number): string => `${String(Math.round(rate * 100))}%`;
const ratio = (counter: Counter): string => `${String(counter.ok)}/${String(counter.total)}`;

export interface TableOptions {
  /**
   * Name the blind cases like the open ones. For fixing an expectation,
   * never for writing briefs or prompts: a blind case read for those is
   * an open one.
   */
  readonly showBlind?: boolean | undefined;
}

/** Cases passed per tag, the tags with the most cases first. */
export const tagScores = (
  cases: ReadonlyArray<CaseReport>,
): ReadonlyArray<readonly [tag: string, score: Counter]> => {
  const tags = new Map<string, { ok: number; total: number }>();
  for (const benchCase of cases) {
    for (const tag of benchCase.tags) {
      const counter = tags.get(tag) ?? { ok: 0, total: 0 };
      counter.total += 1;
      counter.ok += benchCase.ok ? 1 : 0;
      tags.set(tag, counter);
    }
  }
  return [...tags].sort(
    ([a, scoreA], [b, scoreB]) => scoreB.total - scoreA.total || a.localeCompare(b),
  );
};

/** One case's line: how it went, how long it took, and what its failing turns gave. */
const caseLine = (benchCase: CaseReport): string => {
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
          // Whose fault it was is a failing turn's question.
          turn.said === undefined || turn.failed.length === 0
            ? ''
            : turn.said.ok
              ? ', the transcript passes'
              : ', the transcript fails too'
        })`,
      );
    }
  }
  return `  ${benchCase.ok ? 'ok ' : '-- '} ${seconds(total).padStart(6)}  ${benchCase.id}${
    benchCase.blind === true ? ' (blind)' : ''
  }${details.length === 0 ? '' : `  →  ${details.join(' · ')}`}`;
};

const fieldSummary = (score: Score): string =>
  FIELDS.filter((field) => score.fields[field] !== undefined)
    .map((field) => `${field} ${ratio(score.fields[field]!)}`)
    .join(' · ');

const setLine = (name: string, score: Score): string =>
  `   ${name}: ${[`cases ${ratio(score.cases)}`, `turns ${ratio(score.turns)}`, fieldSummary(score)]
    .filter(Boolean)
    .join(' · ')}`;

/** The open and the blind cases apart, once a report holds blind ones: the blind by their counts alone. */
const setLines = (cases: ReadonlyArray<CaseReport>): ReadonlyArray<string> => {
  const blind = cases.filter((benchCase) => benchCase.blind === true);
  return blind.length === 0
    ? []
    : [
        setLine('open', scoreOf(cases.filter((benchCase) => benchCase.blind !== true))),
        setLine('blind', scoreOf(blind)),
      ];
};

/**
 * The run as a table: one line per case with its failing turns, then the
 * score, the open cases passed per tag and, where the report holds blind
 * cases, the two sets apart. A blind case has no line of its own, is
 * counted under no tag (a tag with one blind case would give its outcome
 * away) and is never named among the cases a rescore left alone.
 */
export const formatReport = (
  report: BenchReport,
  { showBlind = false }: TableOptions = {},
): string => {
  const shown = report.cases.filter((benchCase) => showBlind || benchCase.blind !== true);
  const lines: Array<string> = [
    `== ${report.provider}${report.settings === undefined ? '' : ` (${report.settings})`}`,
    ...shown.map(caseLine),
  ];
  const { score } = report;
  lines.push(
    '',
    `   cases ${ratio(score.cases)} · turns ${ratio(score.turns)} · median ${seconds(score.medianMs)} per turn`,
    `   ${fieldSummary(score)}`,
  );
  const tags = tagScores(shown);
  if (tags.length > 0) {
    lines.push(`   tags: ${tags.map(([tag, counter]) => `${tag} ${ratio(counter)}`).join(' · ')}`);
  }
  lines.push(...setLines(report.cases));
  const stale = report.rescored?.stale ?? [];
  if (stale.length > 0) {
    const blind = new Set(
      report.cases.filter((benchCase) => benchCase.blind === true).map((benchCase) => benchCase.id),
    );
    lines.push(
      `   not scored again (gone, or other turns or words than the report): ${namedCases(
        stale.map((id) => ({ blind: blind.has(id), id })),
        { showBlind },
      )}`,
    );
  }
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
    if (score.recordings.heard !== undefined) {
      const { lostAfter, lostHearing, ok, unjudged } = score.recordings.heard;
      lines.push(
        `   heard turns: ${String(ok)}/${String(transcribed)} pass · ${String(lostHearing)} lost to the hearing (the words as said pass) · ${String(lostAfter)} lost after it (the words as said fail too)${
          unjudged > 0
            ? ` · ${String(unjudged)} not judged (misheard, and the words as said never read: scored again from a run they passed)`
            : ''
        }`,
      );
    }
  }
  if (score.places !== undefined) {
    const { asked, errors, missed, offered, taken, text } = score.places;
    lines.push(
      `   places asked of MapKit: ${String(asked)} · taken ${String(taken)} · offered ${String(offered)} · right as text only ${String(text)} · missed ${String(missed)}${
        errors === 0
          ? ''
          : ` (${String(errors)} with a MapKit call that failed or gave no answer in time: a miss may be that)`
      }`,
    );
  }
  return lines.join('\n');
};

/** The earlier run as a comparison names it: by its model too, where the two runs are of two models. */
export const earlierRun = (
  before: { readonly provider: string; readonly sha: string; readonly when: string },
  after: { readonly provider: string },
): string =>
  `${before.provider === after.provider ? '' : `${before.provider} at `}${before.sha} (${before.when.slice(0, 16)})`;

/** Says when two runs read on two days: what "this week" and "Friday" mean moved between them. */
export const otherDay = (
  before: { readonly today: string },
  after: { readonly today: string },
): ReadonlyArray<string> =>
  before.today === after.today
    ? []
    : [`   read on two days, ${before.today} → ${after.today}: name one (MODEL_BENCH_TODAY)`];

/** Whether two runs of a case read the same words, turn by turn. */
const sameWords = (before: CaseReport, after: CaseReport): boolean =>
  before.turns.length === after.turns.length &&
  before.turns.every((turn, index) => turn.input === after.turns[index]?.input);

/**
 * The cases two runs read in other words (a case reworded between them,
 * a recording heard differently): no pair of answers to one phrase, so
 * they are named and left out of the flips and of the test on them.
 */
export const notCompared = (
  apart: ReadonlyArray<Flip>,
  options: TableOptions = {},
): ReadonlyArray<string> =>
  apart.length === 0
    ? []
    : [`   not compared (other words in the two runs): ${namedCases(apart, options)}`];

/**
 * The report as the before/after of a change: what moved, case by case
 * and in the score, and whether chance alone would move as much
 * (`flips.ts`). A blind case that flipped is counted, not named, and a
 * case the two runs read in other words is no flip at all.
 */
export const compareReports = (
  before: BenchReport,
  after: BenchReport,
  options: TableOptions = {},
): string => {
  const earlier = new Map(before.cases.map((benchCase) => [benchCase.id, benchCase]));
  const fixed: Array<Flip> = [];
  const broke: Array<Flip> = [];
  const apart: Array<Flip> = [];
  for (const benchCase of after.cases) {
    const previous = earlier.get(benchCase.id);
    if (previous === undefined) {
      continue;
    }
    const flip = { blind: benchCase.blind === true, id: benchCase.id };
    if (!sameWords(previous, benchCase)) {
      apart.push(flip);
    } else if (previous.ok !== benchCase.ok) {
      (benchCase.ok ? fixed : broke).push(flip);
    }
  }
  const moved = (field: Field): string | undefined => {
    const was = before.score.fields[field];
    const is = after.score.fields[field];
    return was === undefined || is === undefined || (was.ok === is.ok && was.total === is.total)
      ? undefined
      : `${field} ${ratio(was)} → ${ratio(is)}`;
  };
  return [
    `   vs ${earlierRun(before, after)}: cases ${ratio(before.score.cases)} → ${ratio(
      after.score.cases,
    )}, turns ${ratio(before.score.turns)} → ${ratio(after.score.turns)}`,
    ...(before.settings === after.settings
      ? []
      : [
          `   settings: ${before.settings ?? 'not recorded'} → ${after.settings ?? 'not recorded'}`,
        ]),
    ...otherDay(before, after),
    ...flipLines({ broke, fixed }, options),
    ...notCompared(apart, options),
    ...FIELDS.map(moved)
      .filter((line): line is string => line !== undefined)
      .map((line) => `   ${line}`),
  ].join('\n');
};

const slug = (text: string): string =>
  text.replaceAll(/[^a-z0-9]+/gi, '-').replaceAll(/^-|-$/g, '');

const stampOf = (when: string): string =>
  when
    .slice(0, 19)
    .replaceAll(/[-:T]/g, '')
    .replace(/(\d{8})(\d{6})/, '$1-$2');

/**
 * Writes the report under `dir` and returns its path. A report scored
 * again names the run it came from too: a folder of them is scored within
 * one second, and two of one provider would land on one name.
 */
export const writeReport = (dir: string, report: BenchReport): string => {
  mkdirSync(dir, { recursive: true });
  const source =
    report.rescored === undefined
      ? ''
      : `-of-${stampOf(report.rescored.when)}-${report.rescored.sha}`;
  const path = join(
    dir,
    `${stampOf(report.when)}-${report.sha}-${slug(report.provider)}${source}.json`,
  );
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
};
