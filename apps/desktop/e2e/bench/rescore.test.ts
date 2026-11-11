import { describe, expect, it } from 'vite-plus/test';
import type { BenchCase } from './cases.ts';
import type { BenchDraft } from './check.ts';
import type { BenchReport, TurnReport } from './report.ts';
import { rescore } from './rescore.ts';

// A Tuesday; the report says which day it ran on.
const TODAY = '2026-11-10';

const draft = (prefill: Record<string, unknown> = {}): BenchDraft => ({
  choices: [],
  guests: [],
  item: {
    kind: 'event',
    prefill: {
      date: '2026-11-13',
      endTime: '20:00',
      isAllDay: false,
      startTime: '19:00',
      title: 'Dinner',
      ...prefill,
    },
  },
});

const turn = (outcome: unknown, rest: Partial<TurnReport> = {}): TurnReport => ({
  calls: [],
  checked: ['title'],
  failed: [],
  input: 'words',
  notes: [],
  outcome,
  ...rest,
});

const report = (turns: ReadonlyArray<TurnReport>, id = 'dinner'): BenchReport => ({
  cases: [{ id, ok: true, tags: [], turns }],
  provider: 'apple+plain',
  score: { cases: { ok: 1, total: 1 }, fields: {}, medianMs: 0, turns: { ok: 1, total: 1 } },
  sha: 'aaaaaaaa',
  timeZone: 'Europe/Vienna',
  today: TODAY,
  when: '2026-11-10T12:00:00.000Z',
});

const benchCase = (
  expectations: ReadonlyArray<BenchCase['turns'][number]['expect']>,
): BenchCase => ({
  contacts: 'team',
  id: 'dinner',
  lang: 'en',
  tags: [],
  turns: expectations.map((expect) => ({ expect, input: { text: 'words' } })),
});

const NOW = { sha: 'bbbbbbbb', when: '2026-11-11T08:00:00.000Z' };

/** The last turn's transcript verdict after the report is scored again. */
const saidOf = (before: BenchReport, expectations: Parameters<typeof benchCase>[0]) =>
  rescore(before, [benchCase(expectations)], NOW).cases[0]?.turns.at(-1)?.said;

describe('rescore', () => {
  it('checks each stored outcome again, the draft before it being the report’s own', () => {
    const before = report([
      // Passed when a first phrase could invent a place.
      turn({ draft: draft({ location: 'nichts' }), kind: 'draft' }),
      // The place was there before the turn: unchanged, and a pass.
      turn({ draft: draft({ location: 'nichts', title: 'Team dinner' }), kind: 'draft' }),
    ]);
    const after = rescore(
      before,
      [benchCase([{ title: 'dinner', weekday: 5 }, { title: 'team dinner' }])],
      NOW,
    );
    expect(after.cases[0]).toMatchObject({
      ok: false,
      turns: [
        {
          checked: ['title', 'date', 'unsaid'],
          failed: ['unsaid'],
          notes: ['unsaid location: nichts'],
        },
        { checked: ['title', 'unchanged'], failed: [], notes: [] },
      ],
    });
    expect(after.score).toMatchObject({ cases: { ok: 0, total: 1 }, turns: { ok: 1, total: 2 } });
    expect(after).toMatchObject({
      provider: 'apple+plain',
      rescored: { sha: 'aaaaaaaa', when: '2026-11-10T12:00:00.000Z' },
      sha: 'bbbbbbbb',
      today: TODAY,
      when: '2026-11-11T08:00:00.000Z',
    });
  });

  it('keeps a refusal refused, a turn without a draft failed, and the notes about a recording', () => {
    const before = report([
      turn(
        { kind: 'rejected', reason: 'Nothing to schedule was understood.' },
        { failed: ['title'] },
      ),
      turn(undefined, {
        failed: ['title'],
        notes: ['no draft to change', 'recording not read: no speech'],
      }),
    ]);
    const after = rescore(
      before,
      [benchCase([{ title: 'dinner' }, { title: 'team dinner' }])],
      NOW,
    );
    expect(after.cases[0]?.turns).toMatchObject([
      {
        failed: ['title', 'unsaid'],
        notes: ['rejected: Nothing to schedule was understood.'],
      },
      {
        // As the run scored it: every named field, and neither rule, with no draft to hold it to.
        checked: ['title'],
        failed: ['title'],
        notes: ['no draft to change', 'recording not read: no speech'],
      },
    ]);
  });

  it('scores the transcript’s own parse again, and says nothing where it cannot', () => {
    const misheard = { draft: draft({ title: 'Diner' }), kind: 'draft' };
    const transcript = { draft: draft({ location: 'nichts' }), kind: 'draft' };
    // The transcript passed when a first phrase could invent a place.
    const kept = report([
      turn(misheard, { failed: ['title'], said: { notes: [], ok: true, outcome: transcript } }),
    ]);
    expect(saidOf(kept, [{ title: 'dinner' }])).toEqual({
      notes: ['unsaid location: nichts'],
      ok: false,
      outcome: transcript,
    });
    // An earlier report kept the verdict alone: it is not this scoring's to repeat.
    const verdictOnly = report([
      turn(misheard, { failed: ['title'], said: { notes: [], ok: true } }),
    ]);
    expect(saidOf(verdictOnly, [{ title: 'dinner' }])).toBeUndefined();
    // A turn that passes now keeps the transcript's outcome: a stricter scoring after this one judges it again.
    const passing = rescore(kept, [benchCase([{ title: 'diner' }])], NOW);
    expect(passing.cases[0]?.ok).toBe(true);
    expect(saidOf(passing, [{ title: 'dinner' }])).toEqual({
      notes: ['unsaid location: nichts'],
      ok: false,
      outcome: transcript,
    });
    // A later turn's transcript is held to the draft before the turn, not the one the turn made.
    const moved = draft({ endTime: '22:00', startTime: '21:00', title: 'Team dinner' });
    const asSaid = draft({ endTime: '21:00', startTime: '20:00', title: 'Team dinner' });
    const later = report([
      turn({ draft: draft(), kind: 'draft' }),
      turn(
        { draft: moved, kind: 'draft' },
        {
          failed: ['time'],
          said: { notes: [], ok: true, outcome: { draft: asSaid, kind: 'draft' } },
        },
      ),
    ]);
    expect(
      saidOf(later, [{ title: 'dinner' }, { endTime: '21:00', startTime: '20:00' }]),
    ).toMatchObject({ notes: ['changed title: team dinner'], ok: false });
  });

  it('names the run, not the scoring before, when a rescored report is scored again', () => {
    const cases = [benchCase([{ title: 'dinner' }])];
    const once = rescore(report([turn({ draft: draft(), kind: 'draft' })]), cases, NOW);
    const twice = rescore(once, cases, { sha: 'cccccccc', when: '2026-11-12T08:00:00.000Z' });
    // Two reports scored in one second share that scoring's sha and time; their runs differ.
    expect(twice).toMatchObject({
      rescored: { sha: 'aaaaaaaa', when: '2026-11-10T12:00:00.000Z' },
      sha: 'cccccccc',
      when: '2026-11-12T08:00:00.000Z',
    });
  });

  it('leaves a case alone that is gone or has other turns than the report', () => {
    const before = report([turn({ draft: draft({ location: 'nichts' }), kind: 'draft' })]);
    expect(rescore(before, [], NOW).cases).toEqual(before.cases);
    expect(
      rescore(before, [benchCase([{ title: 'dinner' }, { title: 'team dinner' }])], NOW).cases,
    ).toEqual(before.cases);
  });
});
