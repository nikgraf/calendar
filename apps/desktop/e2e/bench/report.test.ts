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
  tagScores,
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
      heard: { lostAfter: 0, lostHearing: 1, ok: 0, unjudged: 0 },
      missing: 0,
      skipped: 0,
      transcribed: 1,
      wordErrorRate: 1 / 3,
    });
    expect(score.places).toBeUndefined();
  });

  it('says where each heard turn was lost, and what the lookup made of each place asked', () => {
    const lookup = (found: {
      errors?: ReadonlyArray<string>;
      offered?: number;
      taken?: boolean;
    }) => ({
      draft: { place: { candidates: [], errors: [], taken: false, ...found } },
      kind: 'draft',
    });
    const heard = (over: Partial<TurnReport>) => turn({ audio: 'transcribed', ...over });
    const cases: ReadonlyArray<CaseReport> = [
      {
        id: 'voices',
        ok: false,
        tags: [],
        turns: [
          // Passes as heard, its place taken.
          heard({ outcome: lookup({ offered: 1, taken: true }), wordErrorRate: 0.2 }),
          // Passes, its place among those to pick from.
          heard({ outcome: lookup({ offered: 2 }), wordErrorRate: 0 }),
          // The lookup found nothing, the text names it all the same.
          heard({ outcome: lookup({}), wordErrorRate: 0 }),
          // Lost to the hearing: the words as said pass.
          heard({
            checked: ['location'],
            failed: ['location'],
            outcome: lookup({ errors: ['geo.search: throttled'] }),
            said: { notes: [], ok: true },
            wordErrorRate: 0.5,
          }),
          // Lost after it: the words as said fail too, and words heard right that fail.
          heard({ failed: ['time'], said: { notes: [], ok: false }, wordErrorRate: 0.1 }),
          heard({ failed: ['time'], wordErrorRate: 0 }),
          // Misheard and failing, its words as said never read (it passed when it ran): not judged.
          heard({ failed: ['time'], wordErrorRate: 0.3 }),
          // A typed turn is no heard one.
          turn({ failed: ['title'] }),
        ],
      },
    ];
    const score = scoreOf(cases);
    expect(score.recordings?.heard).toEqual({ lostAfter: 2, lostHearing: 1, ok: 3, unjudged: 1 });
    expect(score.places).toEqual({
      asked: 4,
      errors: 1,
      missed: 1,
      offered: 1,
      taken: 1,
      text: 1,
    });
    const text = formatReport(report(cases));
    expect(text).toContain(
      'heard turns: 3/7 pass · 1 lost to the hearing (the words as said pass) · 2 lost after it (the words as said fail too) · 1 not judged (misheard, and the words as said never read: scored again from a run they passed)',
    );
    // Nothing to say of it where every failing turn was judged.
    expect(formatReport(report(CASES))).not.toContain('not judged');
    expect(text).toContain(
      'places asked of MapKit: 4 · taken 1 · offered 1 · right as text only 1 · missed 1 (1 with a MapKit call that failed or gave no answer in time: a miss may be that)',
    );
    // A report from before these were counted prints neither line.
    const { heard: _heard, ...before } = score.recordings!;
    const old = formatReport(
      report(cases, { score: { ...score, places: undefined, recordings: before } }),
    );
    expect(old).not.toContain('heard turns');
    expect(old).not.toContain('places asked');
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

  it('says what the run set beyond the provider, and which cases a rescore left alone', () => {
    const text = formatReport(
      report(CASES, {
        provider: 'openai:lfm3',
        rescored: { sha: 'old0000', stale: ['dinner'], when: '2026-08-21T09:00:00.000Z' },
        settings: 'http://127.0.0.1:11434/v1 {"reasoning_effort":"none"}',
      }),
    );
    expect(text).toContain(
      '== openai:lfm3 (http://127.0.0.1:11434/v1 {"reasoning_effort":"none"})',
    );
    expect(text).toContain(
      '   not scored again (gone, or other turns or words than the report): dinner',
    );
    expect(formatReport(report(CASES))).not.toContain('not scored again');
  });

  it('places no fault on a turn that passes, whatever a rescored report kept of the transcript', () => {
    const passing = turn({
      audio: 'transcribed',
      heard: 'make it late',
      said: { notes: ['start=19:00'], ok: false, outcome: { kind: 'rejected', reason: 'none' } },
      wordErrorRate: 1 / 3,
    });
    expect(formatReport(report([{ id: 'a', ok: true, tags: [], turns: [passing] }]))).toContain(
      '  ok    1.0s  a  →  heard "make it late" (WER 33%)',
    );
  });
});

const tagged = (id: string, ok: boolean, tags: ReadonlyArray<string>): CaseReport => ({
  id,
  ok,
  tags,
  turns: [turn()],
});

describe('tagScores', () => {
  it('counts the cases passed per tag, the largest tag first and ties by name', () => {
    expect(
      tagScores([
        tagged('a', true, ['flow', 'de']),
        tagged('b', false, ['flow']),
        tagged('c', true, ['basic']),
        tagged('d', true, []),
      ]),
    ).toEqual([
      ['flow', { ok: 1, total: 2 }],
      ['basic', { ok: 1, total: 1 }],
      ['de', { ok: 1, total: 1 }],
    ]);
  });
});

describe('formatReport — tags and blind cases', () => {
  const BLIND: ReadonlyArray<CaseReport> = [
    ...CASES,
    {
      blind: true,
      id: 'sealed-lunch',
      ok: false,
      tags: ['flow'],
      turns: [turn({ failed: ['title'], notes: ['title=Lunch at'] })],
    },
    { blind: true, id: 'sealed-call', ok: true, tags: [], turns: [turn()] },
  ];

  it('prints the cases passed per tag, and no tag line for cases without tags', () => {
    expect(formatReport(report(CASES))).toContain('   tags: flow 0/1');
    expect(formatReport(report([CASES[0]!]))).not.toContain('tags:');
  });

  it('counts a blind case in every score and gives it no line of its own', () => {
    const text = formatReport(report(BLIND));
    expect(text).not.toContain('sealed');
    expect(text).not.toContain('Lunch at');
    // Every case counts in the score. A tag counts the open cases only: a
    // tag with one blind case would give that case's outcome away.
    expect(text).toContain('cases 2/4 · turns 3/5');
    expect(text).toContain('   tags: flow 0/1');
    expect(text).not.toContain('flow 0/2');
    // The two sets apart, the blind one by its counts alone.
    expect(text).toContain(
      '   open: cases 1/2 · turns 2/3 · title 2/2 · date 2/2 · time 0/1 · unchanged 1/1',
    );
    expect(text).toContain('   blind: cases 1/2 · turns 1/2 · title 1/2 · date 2/2');
    // A report without blind cases says nothing of sets.
    expect(formatReport(report(CASES))).not.toContain('open:');
  });

  it('names blind cases only when asked to', () => {
    const text = formatReport(report(BLIND), { showBlind: true });
    expect(text).toContain('sealed-lunch (blind)  →  title=Lunch at');
    expect(text).toContain('sealed-call (blind)');
    expect(text).not.toContain('dinner (blind)');
    expect(text).toContain('   tags: flow 0/2');
  });

  it('counts a blind case a rescore left alone, and names the open ones', () => {
    const rescored = report(BLIND, {
      rescored: { sha: 'old0000', stale: ['dinner', 'sealed-lunch'], when: '2026-08-21T09:00' },
    });
    expect(formatReport(rescored)).toContain(
      '   not scored again (gone, or other turns or words than the report): dinner · 1 blind',
    );
    expect(formatReport(rescored, { showBlind: true })).toContain('dinner, sealed-lunch');
  });

  it('prints a set of cases without fields without a dangling separator', () => {
    const bare: CaseReport = { blind: true, id: 'sealed', ok: true, tags: [], turns: [] };
    expect(formatReport(report([CASES[0]!, bare])).split('\n')).toContain(
      '   blind: cases 1/1 · turns 0/0',
    );
  });
});

describe('compareReports', () => {
  it('counts a blind case that flipped without naming it, and says what chance would do', () => {
    const before = report([
      ...CASES,
      { blind: true, id: 'sealed', ok: false, tags: [], turns: [turn({ failed: ['title'] })] },
    ]);
    const after = report([
      CASES[0]!,
      {
        ...CASES[1]!,
        ok: true,
        turns: [turn(), turn({ checked: ['time', 'unchanged'], input: 'make it late' })],
      },
      { blind: true, id: 'sealed', ok: true, tags: [], turns: [turn()] },
    ]);
    const text = compareReports(before, after);
    expect(text).toContain('   fixed: flow-dinner · 1 blind');
    expect(text).not.toContain('sealed');
    expect(text).toContain(
      '   2 fixed, 0 broke: by chance alone p = 0.50, not told apart from chance',
    );
    expect(compareReports(before, after, { showBlind: true })).toContain(
      '   fixed: flow-dinner, sealed',
    );
    // Nothing flipped: no line about chance.
    expect(compareReports(before, before)).not.toContain('chance');
  });

  it('names the cases that flipped and the fields that moved', () => {
    const before = report(CASES, { sha: 'old0000', when: '2026-08-21T09:00:00.000Z' });
    const after = report([
      { ...CASES[0]!, ok: false, turns: [turn({ failed: ['title'], notes: ['title=Sarah'] })] },
      {
        ...CASES[1]!,
        ok: true,
        turns: [turn(), turn({ checked: ['time', 'unchanged'], input: 'make it late' })],
      },
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

  it('says when the two runs were not set up alike', () => {
    const thinking = report(CASES, { provider: 'openai:lfm3', settings: 'http://localhost/v1' });
    const quiet = report(CASES, {
      provider: 'openai:lfm3',
      settings: 'http://localhost/v1 {"reasoning_effort":"none"}',
    });
    expect(compareReports(thinking, quiet)).toContain(
      '   settings: http://localhost/v1 → http://localhost/v1 {"reasoning_effort":"none"}',
    );
    expect(compareReports(report(CASES), quiet)).toContain('   settings: not recorded → ');
    expect(compareReports(quiet, quiet)).not.toContain('settings');
  });

  it('leaves a case out of the flips when the two runs read other words', () => {
    const before = report(CASES);
    const reworded: CaseReport = {
      ...CASES[1]!,
      ok: true,
      turns: [turn({ input: 'Dinner with Teo on Friday' }), turn({ checked: ['time'] })],
    };
    const text = compareReports(before, report([CASES[0]!, reworded]));
    // It passes now, but to another phrase: no flip, and no test on it.
    expect(text).not.toContain('fixed');
    expect(text).not.toContain('chance');
    expect(text).toContain('   not compared (other words in the two runs): flow-dinner');
    // A blind one is counted, not named.
    const sealed = { ...reworded, blind: true };
    expect(compareReports(before, report([CASES[0]!, sealed]))).toContain(
      '   not compared (other words in the two runs): 1 blind',
    );
    // Another number of turns is other words too.
    const shorter = { ...CASES[1]!, ok: true, turns: [turn({ ms: 2000 })] };
    expect(compareReports(before, report([CASES[0]!, shorter]))).toContain('not compared');
  });

  it('says when the two runs read on two days', () => {
    const sunday = report(CASES, { today: '2026-11-15' });
    const wednesday = report(CASES, { today: '2026-11-18' });
    expect(compareReports(sunday, wednesday)).toContain(
      '   read on two days, 2026-11-15 → 2026-11-18: name one (MODEL_BENCH_TODAY)',
    );
    expect(compareReports(sunday, sunday)).not.toContain('read on two days');
  });

  it('names the earlier run’s model where the two runs are of two models', () => {
    const v1 = report(CASES, { provider: 'openai:assistant-v1+tuned', sha: 'old0000' });
    const v2 = report(CASES, { provider: 'openai:assistant-v2+tuned' });
    expect(compareReports(v1, v2)).toContain(
      '   vs openai:assistant-v1+tuned at old0000 (2026-08-22T10:20): cases 1/2 → 1/2',
    );
    expect(compareReports(v1, v1)).toContain('   vs old0000 (2026-08-22T10:20): cases');
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

  it('names a report scored again by its run too: a folder of them is scored in one second', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-'));
    const again = (rescored: BenchReport['rescored']): string =>
      writeReport(
        dir,
        report(CASES, { rescored, sha: 'def5678-dirty', when: '2026-08-23T08:00:00.100Z' }),
      );
    const first = again({ sha: 'abc1234', when: '2026-08-22T10:20:30.000Z' });
    const second = again({ sha: 'abc1234', when: '2026-08-21T09:00:00.000Z' });
    expect(basename(first)).toBe(
      '20260823-080000-def5678-dirty-apple-of-20260822-102030-abc1234.json',
    );
    expect(basename(second)).toBe(
      '20260823-080000-def5678-dirty-apple-of-20260821-090000-abc1234.json',
    );
    expect(existsSync(first) && existsSync(second)).toBe(true);
  });
});
