import { type AssistantSession, SESSION_LOG_VERSION, type SessionTurn } from '@calendar/ai';
import { describe, expect, it } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCases } from './cases.ts';
import { draftCase, formatSummary, summarize, threadEnd } from './sessions.ts';

const turn = (text: string, extra: Partial<SessionTurn> = {}): SessionTurn => ({
  at: '2026-11-26T08:00:00.000Z',
  day: '2026-11-26',
  input: 'typed',
  outcome: { kind: 'changed', summary: '' },
  reads: [],
  route: 'first',
  text,
  ...extra,
});

const session = (id: string, extra: Partial<AssistantSession>): AssistantSession => ({
  app: { platform: 'iPhone', version: '0.1.0' },
  endedAt: '2026-11-26T08:01:00.000Z',
  id,
  left: 0,
  model: 'v2',
  origin: 'new',
  picks: [],
  saved: [],
  startedAt: '2026-11-26T08:00:00.000Z',
  timeZone: 'Europe/Vienna',
  turns: [turn('lunch tomorrow at 1')],
  v: SESSION_LOG_VERSION,
  ...extra,
});

const lunch = {
  date: '2026-11-27',
  edited: [],
  endTime: '14:00',
  guests: 0,
  isAllDay: false,
  kind: 'event' as const,
  startTime: '13:00',
  title: 'Lunch',
};

const untouched = session('a', { saved: [lunch] });
const edited = session('b', {
  saved: [{ ...lunch, edited: ['time', 'location'] }],
  turns: [
    turn('lunch at one', {
      heard: { segments: [{ text: 'lunch at one' }], text: 'lunch at one' },
      input: 'dictated',
      parakeet: true,
    }),
  ],
});
const abandoned = session('c', {
  turns: [
    turn('dinner friday', { input: 'dictated' }),
    turn('invite bob', { outcome: { kind: 'refused', message: 'x' } }),
  ],
});

describe('summarize', () => {
  it('tells threads saved untouched, edited by hand and abandoned, by how they were said', () => {
    expect([untouched, edited, abandoned].map(threadEnd)).toEqual([
      'untouched',
      'edited',
      'abandoned',
    ]);
    const summary = summarize([untouched, edited, abandoned]);
    expect(summary.ends).toEqual({
      dictated: { abandoned: 0, edited: 1, untouched: 0 },
      mixed: { abandoned: 1, edited: 0, untouched: 0 },
      typed: { abandoned: 0, edited: 0, untouched: 1 },
    });
    expect(summary.fields).toEqual([
      ['location', 1],
      ['time', 1],
    ]);
    expect(summary.outcomes.typed).toEqual({ changed: 1, refused: 1 });
    expect(summary.parakeet).toBe(1);
    expect(formatSummary(summary)).toContain('dictated  0 / 1 / 0');
  });
});

describe('draftCase', () => {
  it('replays the turns taken, the last held to where the item was saved', () => {
    const drafted = draftCase(
      session('d', {
        saved: [{ ...lunch, location: 'Café Central' }],
        turns: [
          turn('lunch tomorrow'),
          turn('at 2', { undone: true }),
          turn('no wait', { outcome: { kind: 'refused', message: 'x' } }),
          turn('at 1', { input: 'dictated', route: 'change' }),
        ],
      }),
    );
    expect(drafted).toEqual({
      lang: 'en',
      tags: ['phone', 'dictated', 'typed', 'flow'],
      turns: [
        { expect: {}, input: { text: 'lunch tomorrow' } },
        {
          expect: {
            dayOffset: 1,
            endTime: '14:00',
            location: 'Café Central',
            startTime: '13:00',
            title: 'Lunch',
          },
          input: { text: 'at 1' },
        },
      ],
    });
  });

  it('is a case the bench loads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-case-'));
    try {
      writeFileSync(join(dir, 'phone-a.json'), JSON.stringify(draftCase(untouched)));
      expect(loadCases(dir)[0]).toMatchObject({ id: 'phone-a', tags: ['phone', 'typed'] });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('is nothing for a thread with no turn taken', () => {
    expect(
      draftCase(session('e', { turns: [turn('x', { outcome: { kind: 'failed' } })] })),
    ).toBeUndefined();
  });
});
