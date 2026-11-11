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
        // As the run scored it: every named field, with no draft to hold it to.
        checked: ['title', 'unsaid'],
        failed: ['title', 'unsaid'],
        notes: ['no draft to change', 'recording not read: no speech'],
      },
    ]);
  });

  it('leaves a case alone that is gone or has other turns than the report', () => {
    const before = report([turn({ draft: draft({ location: 'nichts' }), kind: 'draft' })]);
    expect(rescore(before, [], NOW).cases).toEqual(before.cases);
    expect(
      rescore(before, [benchCase([{ title: 'dinner' }, { title: 'team dinner' }])], NOW).cases,
    ).toEqual(before.cases);
  });
});
