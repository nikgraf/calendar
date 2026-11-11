import { Contact } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import type { BenchCase } from './cases.ts';
import { comparePhone, firstTurns, type PhoneReport, scorePhoneReport } from './phoneReport.ts';
import type { BenchReport } from './report.ts';

// A Wednesday; the phone's report says which day it read the phrases on.
const TODAY = '2026-11-11';

const benchCase = (id: string, text: string, expect: BenchCase['turns'][number]['expect']) =>
  ({
    contacts: 'team',
    id,
    lang: 'en',
    tags: ['basic'],
    turns: [
      { expect: { kind: 'event', ...expect }, input: { text } },
      { expect: { startTime: '20:00' }, input: { text: 'make it 8' } },
    ],
  }) satisfies BenchCase;

const CASES = [
  benchCase('dinner', 'Dinner on Friday at 7pm', {
    startTime: '19:00',
    title: 'dinner',
    weekday: 5,
  }),
  benchCase('lunch', 'Lunch on Friday at 1pm', { startTime: '13:00', title: 'lunch', weekday: 5 }),
];

const BOOKS = {
  team: [
    new Contact({ displayName: 'Teo', email: 'teo@example.com', id: 'device:0', source: 'device' }),
  ],
};

const parsed = (title: string, startTime: string, endTime: string) => ({
  kind: 'parsed' as const,
  prefill: { date: '2026-11-13', endTime, isAllDay: false, startTime, title },
});

const phone = (rows: PhoneReport['rows']): PhoneReport => ({
  gpu: false,
  model: { name: 'LFM3 1.7B' },
  rows,
  timeZone: 'Europe/Vienna',
  today: TODAY,
  when: '2026-11-11T09:00:00.000Z',
});

describe('scorePhoneReport', () => {
  it('holds each first phrase to its case, as a report of first turns', async () => {
    const { left, report } = await scorePhoneReport(
      phone([
        {
          id: 'dinner',
          input: 'Dinner on Friday at 7pm',
          ms: 2500,
          result: parsed('Dinner', '19:00', '20:00'),
        },
        // An hour off.
        {
          id: 'lunch',
          input: 'Lunch on Friday at 1pm',
          ms: 3500,
          result: parsed('Lunch', '12:00', '13:00'),
        },
      ]),
      CASES,
      BOOKS,
      'abc12345',
    );
    expect(left).toEqual([]);
    expect(report).toMatchObject({
      cases: [
        { id: 'dinner', ok: true, turns: [{ failed: [], ms: 2500 }] },
        { id: 'lunch', ok: false, turns: [{ failed: ['time'], ms: 3500 }] },
      ],
      provider: 'phone:LFM3 1.7B (no GPU)',
      score: { cases: { ok: 1, total: 2 }, medianMs: 3000, turns: { ok: 1, total: 2 } },
      sha: 'abc12345',
      today: TODAY,
    });
  });

  it('fails a phrase the phone refused or could not ask, and leaves out a case that changed', async () => {
    const { left, report } = await scorePhoneReport(
      phone([
        {
          id: 'dinner',
          input: 'Dinner on Friday at 7pm',
          ms: 900,
          result: { kind: 'rejected', reason: 'no' },
        },
        {
          id: 'lunch',
          input: 'Lunch on Friday at 1pm',
          ms: 10,
          result: { kind: 'failed', message: 'no model' },
        },
        // The case says "at 1pm" now; the phone read another phrase.
        {
          id: 'lunch',
          input: 'Lunch on Friday at noon',
          ms: 800,
          result: parsed('Lunch', '12:00', '13:00'),
        },
        {
          id: 'gone',
          input: 'A case that was removed',
          ms: 800,
          result: parsed('Gone', '12:00', '13:00'),
        },
      ]),
      CASES,
      BOOKS,
      'abc12345',
    );
    expect(left).toEqual(['lunch', 'gone']);
    expect(report.cases.map((scored) => [scored.id, scored.ok, scored.turns[0]?.notes])).toEqual([
      ['dinner', false, ['rejected: no']],
      ['lunch', false, ['rejected: no model']],
    ]);
  });
});

const turn = (failed: ReadonlyArray<'time' | 'title'>) => ({
  calls: [],
  checked: ['title' as const, 'time' as const],
  failed,
  input: 'x',
  ms: 600,
  notes: [],
  outcome: undefined,
});

describe('firstTurns and comparePhone', () => {
  const mac: BenchReport = {
    cases: [
      // The first turn passes; the case fails on its second.
      { id: 'dinner', ok: false, tags: [], turns: [turn([]), turn(['time'])] },
      { id: 'lunch', ok: false, tags: [], turns: [turn(['title']), turn([])] },
      { id: 'other', ok: true, tags: [], turns: [turn([])] },
    ],
    provider: 'openai:lfm3:1.7b-q4_K_M',
    score: { cases: { ok: 1, total: 3 }, fields: {}, medianMs: 600, turns: { ok: 3, total: 5 } },
    sha: 'd42f52f6',
    timeZone: 'Europe/Vienna',
    today: '2026-11-10',
    when: '2026-11-10T22:00:00.000Z',
  };

  it('counts a Mac report by its first turns, over the cases the phone answered', () => {
    expect(firstTurns(mac, new Set(['dinner', 'lunch']))).toEqual({
      failed: ['lunch'],
      ok: 1,
      total: 2,
    });
  });

  it('names the phrases only one of the two got right', async () => {
    const { report } = await scorePhoneReport(
      phone([
        {
          id: 'dinner',
          input: 'Dinner on Friday at 7pm',
          ms: 2500,
          result: parsed('Dinner', '18:00', '19:00'),
        },
        {
          id: 'lunch',
          input: 'Lunch on Friday at 1pm',
          ms: 2500,
          result: parsed('Lunch', '13:00', '14:00'),
        },
      ]),
      CASES,
      BOOKS,
      'abc12345',
    );
    expect(comparePhone(report, mac)).toBe(
      [
        '   first phrases: phone 1/2, openai:lfm3:1.7b-q4_K_M on the Mac 1/2 (d42f52f6)',
        '   right on the Mac only: dinner',
        '   right on the phone only: lunch',
      ].join('\n'),
    );
  });
});
