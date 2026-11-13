import { Contact } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import type { BenchCase } from './cases.ts';
import { comparePhone, type PhoneReport, scorePhoneReport } from './phoneReport.ts';
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

  it('says when a simulator made the report: its times are the Mac’s, not a phone’s', async () => {
    const rows: PhoneReport['rows'] = [
      {
        id: 'dinner',
        input: 'Dinner on Friday at 7pm',
        ms: 2500,
        result: parsed('Dinner', '19:00', '20:00'),
      },
    ];
    const providerOf = async (over: Partial<PhoneReport>) =>
      (await scorePhoneReport({ ...phone(rows), ...over }, CASES, BOOKS, 'abc12345')).report
        .provider;
    expect(await providerOf({ gpu: true, simulator: true })).toBe('simulator:LFM3 1.7B');
    expect(await providerOf({ gpu: true, simulator: false })).toBe('phone:LFM3 1.7B');
    // A report from before the page said which it was is taken as a phone's.
    expect(await providerOf({ gpu: true })).toBe('phone:LFM3 1.7B');
    expect(await providerOf({ gpu: false, simulator: true })).toBe('simulator:LFM3 1.7B (no GPU)');
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

const turn = (input: string, failed: ReadonlyArray<'time' | 'title'>) => ({
  calls: [],
  checked: ['title' as const, 'time' as const],
  failed,
  input,
  ms: 600,
  notes: [],
  outcome: undefined,
});

const macReport = (cases: BenchReport['cases']): BenchReport => ({
  cases,
  provider: 'openai:lfm3:1.7b-q4_K_M',
  score: { cases: { ok: 0, total: 0 }, fields: {}, medianMs: 600, turns: { ok: 0, total: 0 } },
  sha: 'd42f52f6',
  timeZone: 'Europe/Vienna',
  today: '2026-11-10',
  when: '2026-11-10T22:00:00.000Z',
});

/** The phone's two answers, scored: a dinner and a lunch at the times given. */
const scored = async (dinnerStart: string, lunchStart: string) =>
  (
    await scorePhoneReport(
      phone([
        {
          id: 'dinner',
          input: 'Dinner on Friday at 7pm',
          ms: 2500,
          result: parsed('Dinner', dinnerStart, '20:00'),
        },
        {
          id: 'lunch',
          input: 'Lunch on Friday at 1pm',
          ms: 2500,
          result: parsed('Lunch', lunchStart, '14:00'),
        },
      ]),
      CASES,
      BOOKS,
      'abc12345',
    )
  ).report;

describe('comparePhone', () => {
  it('counts first turns and names the phrases only one of the two got right', async () => {
    const mac = macReport([
      // The first turn passes; the case fails on its second, which is no part of this.
      {
        id: 'dinner',
        ok: false,
        tags: [],
        turns: [turn('Dinner on Friday at 7pm', []), turn('make it 8', ['time'])],
      },
      { id: 'lunch', ok: false, tags: [], turns: [turn('Lunch on Friday at 1pm', ['title'])] },
      { id: 'other', ok: true, tags: [], turns: [turn('Another case', [])] },
    ]);
    expect(comparePhone(await scored('18:00', '13:00'), mac)).toBe(
      [
        '   first phrases both answered: phone 1/2, openai:lfm3:1.7b-q4_K_M on the Mac 1/2 (d42f52f6)',
        '   right on the Mac only: dinner',
        '   right on the phone only: lunch',
      ].join('\n'),
    );
  });

  it('compares only what both answered, in the same words', async () => {
    const mac = macReport([
      // The Mac's recogniser heard other words than the phone was given.
      { id: 'dinner', ok: true, tags: [], turns: [turn('Dinner on Friday at seven', [])] },
      // No lunch: the Mac ran a selection of the cases.
    ]);
    expect(comparePhone(await scored('18:00', '12:00'), mac)).toBe(
      [
        '   first phrases both answered: phone 0/0, openai:lfm3:1.7b-q4_K_M on the Mac 0/0 (d42f52f6)',
        "   not compared (the Mac's report lacks the case, or read other words): dinner, lunch",
      ].join('\n'),
    );
  });
});
