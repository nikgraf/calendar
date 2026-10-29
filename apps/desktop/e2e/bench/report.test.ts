import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  type BenchReport,
  type CaseReport,
  compareReports,
  formatReport,
  scoreOf,
  type TurnReport,
  writeReport,
} from './report.ts';

const turn = (over: Partial<TurnReport> = {}): TurnReport => ({
  calls: [],
  checked: ['title', 'date'],
  failed: [],
  input: 'Dinner with Teo next Friday',
  ms: 1000,
  notes: [],
  outcome: undefined,
  ...over,
});

const CASES: ReadonlyArray<CaseReport> = [
  { id: 'dinner', ok: true, tags: [], turns: [turn()] },
  {
    id: 'flow-dinner',
    ok: false,
    tags: ['flow'],
    turns: [
      turn({ ms: 2000 }),
      turn({
        audio: 'transcribed',
        checked: ['time', 'unchanged'],
        failed: ['time'],
        heard: 'make it late',
        input: 'make it late',
        ms: 3000,
        notes: ['start=19:00'],
        said: { notes: [], ok: true },
        wordErrorRate: 1 / 3,
      }),
    ],
  },
];

const report = (
  cases: ReadonlyArray<CaseReport>,
  over: Partial<BenchReport> = {},
): BenchReport => ({
  cases,
  provider: 'apple',
  score: scoreOf(cases),
  sha: 'abc1234',
  timeZone: 'Europe/Vienna',
  today: '2026-08-22',
  when: '2026-08-22T10:20:30.000Z',
  ...over,
});

describe('scoreOf', () => {
  it('counts cases, turns and every field a turn checked', () => {
    const score = scoreOf(CASES);
    expect(score.cases).toEqual({ ok: 1, total: 2 });
    expect(score.turns).toEqual({ ok: 2, total: 3 });
    expect(score.fields).toEqual({
      date: { ok: 2, total: 2 },
      time: { ok: 0, total: 1 },
      title: { ok: 2, total: 2 },
      unchanged: { ok: 1, total: 1 },
    });
    expect(score.medianMs).toBe(2000);
    expect(score.recordings).toEqual({
      failed: 0,
      missing: 0,
      skipped: 0,
      transcribed: 1,
      wordErrorRate: 1 / 3,
    });
  });

  it('leaves turns that never ran out of the latency, in the failures', () => {
    const score = scoreOf([
      {
        id: 'a',
        ok: false,
        tags: [],
        turns: [
          turn({ failed: ['title'], ms: 10_000, notes: ['rejected: no title'] }),
          turn({
            checked: ['time'],
            failed: ['time'],
            ms: undefined,
            notes: ['no draft to change'],
          }),
          turn({
            checked: ['time'],
            failed: ['time'],
            ms: undefined,
            notes: ['no draft to change'],
          }),
        ],
      },
    ]);
    expect(score.medianMs).toBe(10_000);
    expect(score.turns).toEqual({ ok: 0, total: 3 });
  });

  it('counts recordings that ran as their transcript, and says nothing without any', () => {
    expect(scoreOf([CASES[0]!]).recordings).toBeUndefined();
    expect(scoreOf([]).medianMs).toBe(0);
    const unrecorded = scoreOf([
      {
        id: 'a',
        ok: true,
        tags: [],
        turns: [turn({ audio: 'missing' }), turn({ audio: 'skipped' }), turn({ audio: 'failed' })],
      },
    ]).recordings;
    expect(unrecorded).toEqual({
      failed: 1,
      missing: 1,
      skipped: 1,
      transcribed: 0,
      wordErrorRate: 0,
    });
  });
});

describe('formatReport', () => {
  it('prints one line per case with its failing turns, what was heard, and the score', () => {
    const text = formatReport(report(CASES));
    expect(text).toContain('== apple');
    expect(text).toContain('  ok    1.0s  dinner');
    expect(text).toContain(
      '  --    5.0s  flow-dinner  →  [2] start=19:00 · [2] heard "make it late" (WER 33%, the transcript passes)',
    );
    expect(text).toContain('cases 1/2 · turns 2/3 · median 2.0s per turn');
    expect(text).toContain('title 2/2 · date 2/2 · time 0/1 · unchanged 1/1');
    expect(text).toContain('recordings: 1 transcribed (WER 33%)');
    expect(
      formatReport(
        report([
          {
            id: 'a',
            ok: true,
            tags: [],
            turns: [turn({ audio: 'missing' }), turn({ audio: 'missing' })],
          },
        ]),
      ),
    ).toContain('recordings: 2 missing (ran as the transcript)');
  });
});

describe('compareReports', () => {
  it('names the cases that flipped and the fields that moved', () => {
    const before = report(CASES, { sha: 'old0000', when: '2026-08-21T09:00:00.000Z' });
    const after = report([
      { ...CASES[0]!, ok: false, turns: [turn({ failed: ['title'], notes: ['title=Sarah'] })] },
      { ...CASES[1]!, ok: true, turns: [turn(), turn({ checked: ['time', 'unchanged'] })] },
    ]);
    const text = compareReports(before, after);
    expect(text).toContain('vs old0000 (2026-08-21T09:00): cases 1/2 → 1/2, turns 2/3 → 2/3');
    expect(text).toContain('fixed: flow-dinner');
    expect(text).toContain('broke: dinner');
    expect(text).toContain('title 2/2 → 1/2');
    expect(text).toContain('time 0/1 → 1/1');
    expect(text).not.toContain('date 2/2 → 2/2');
  });

  it('names a field whose total moved with the same passes (cases added or filtered)', () => {
    const before = report([CASES[0]!]);
    const after = report([
      CASES[0]!,
      { ...CASES[0]!, id: 'dinner-2', ok: false, turns: [turn({ failed: ['title'] })] },
    ]);
    expect(compareReports(before, after)).toContain('title 1/1 → 1/2');
  });
});

describe('writeReport', () => {
  it('writes the JSON under the folder, named by time, sha and provider', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-'));
    const path = writeReport(dir, report(CASES, { provider: 'ollama:gemma3:4b' }));
    expect(basename(path)).toBe('20260822-102030-abc1234-ollama-gemma3-4b.json');
    expect(existsSync(path)).toBe(true);
    expect((JSON.parse(readFileSync(path, 'utf8')) as BenchReport).score.cases).toEqual({
      ok: 1,
      total: 2,
    });
  });
});
