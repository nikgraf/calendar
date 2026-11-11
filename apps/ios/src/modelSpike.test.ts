import type { LanguageModel } from '@calendar/ai';
import { describe, expect, it } from 'vite-plus/test';
import { describeAnswer, runSpike, SPIKE_MODELS, type SpikeRow, summarize } from './modelSpike.ts';
import type { OpenModelCall } from './openModel.ts';

const CASES = [
  { id: 'dinner', lang: 'en' as const, text: 'Dinner with Teo on Friday at 7pm' },
  { id: 'dentist', lang: 'en' as const, text: 'Dentist on Friday at 9am' },
  { id: 'lunch', lang: 'en' as const, text: 'Lunch on Friday at 1pm' },
];

const call = (over: Partial<OpenModelCall> = {}): OpenModelCall => ({
  answerMs: 500,
  answerTokens: 20,
  cachedTokens: 300,
  promptMs: 100,
  promptTokens: 100,
  ...over,
});

/** A model that answers every phrase with the same Friday dinner, and counts one call for it. */
const modelFor = (onCall: (made: OpenModelCall) => void): LanguageModel => ({
  generateJson: async () => {
    onCall(call());
    return { date: '2026-11-13', startTime: '19:00', title: 'Dinner with Teo' };
  },
  status: async () => 'ready',
});

const clock = () => {
  let time = 0;
  return () => {
    time += 1000;
    return time;
  };
};

describe('runSpike', () => {
  it('sends each phrase through the quick-add pipeline and keeps its result, time and calls', async () => {
    const seen: Array<number> = [];
    const rows = await runSpike({
      cases: CASES.slice(0, 2),
      modelFor,
      now: clock(),
      onRow: (_row, all) => seen.push(all.length),
      referenceDate: '2026-11-11',
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'dinner',
      input: 'Dinner with Teo on Friday at 7pm',
      ms: 1000,
      result: { kind: 'parsed', prefill: { date: '2026-11-13', startTime: '19:00' } },
    });
    expect(rows[0]?.calls.length).toBeGreaterThan(0);
    expect(seen).toEqual([1, 2]);
  });

  it('stops between phrases, and a phrase the run could not ask is a failed row', async () => {
    let asked = 0;
    const rows = await runSpike({
      cases: CASES,
      modelFor: () => ({
        generateJson: async () => ({}),
        status: async () => 'unavailable',
      }),
      now: clock(),
      referenceDate: '2026-11-11',
      stopped: () => {
        asked += 1;
        return asked > 2;
      },
    });
    expect(rows.map((row) => row.result.kind)).toEqual(['failed', 'failed']);
  });
});

const row = (ms: number, calls: ReadonlyArray<OpenModelCall>, kind: 'parsed' | 'rejected') =>
  ({
    calls,
    id: 'x',
    input: 'x',
    ms,
    result:
      kind === 'rejected'
        ? { kind, reason: 'no' }
        : {
            kind,
            prefill: {
              date: '2026-11-13',
              endTime: '20:00',
              isAllDay: false,
              startTime: '19:00',
              title: 'Dinner',
            },
          },
  }) satisfies SpikeRow;

describe('summarize', () => {
  it('gives the median and the worst turn, tokens per second over every call, and what was cached', () => {
    const summary = summarize([
      row(1000, [call()], 'parsed'),
      row(4000, [call(), call({ error: 'context is busy' })], 'rejected'),
      row(2000, [call({ cachedTokens: 0, promptTokens: 400 })], 'parsed'),
    ]);
    expect(summary).toEqual({
      // 80 tokens in 2 s.
      answerTokensPerSecond: 40,
      // 900 of 1,600 prompt tokens were there already.
      cachedShare: 900 / 1600,
      failedCalls: 1,
      firstError: 'context is busy',
      medianMs: 2000,
      parsed: 2,
      // 700 tokens in 0.4 s.
      promptTokensPerSecond: 1750,
      turns: 3,
      worstMs: 4000,
    });
    expect(summarize([])).toMatchObject({ answerTokensPerSecond: 0, medianMs: 0, turns: 0 });
  });
});

describe('describeAnswer', () => {
  it('says what a phrase came to on one line', () => {
    expect(
      describeAnswer({
        invite: ['Teo'],
        kind: 'parsed',
        prefill: {
          date: '2026-11-13',
          endTime: '20:00',
          isAllDay: false,
          location: 'Figlmüller',
          startTime: '19:00',
          title: 'Dinner',
        },
      }),
    ).toBe('Dinner · 2026-11-13 · 19:00–20:00 · Figlmüller · invites Teo');
    expect(
      describeAnswer({ kind: 'task', prefill: { date: '2026-11-12', title: 'Call the bank' } }),
    ).toBe('to-do · Call the bank · 2026-11-12');
    expect(describeAnswer({ kind: 'rejected', reason: 'Nothing to schedule.' })).toBe(
      'refused: Nothing to schedule.',
    );
    expect(describeAnswer({ kind: 'failed', message: 'no model' })).toBe('failed: no model');
  });
});

describe('SPIKE_MODELS', () => {
  it('names a file, its size and where it comes from, each once', () => {
    expect(new Set(SPIKE_MODELS.map((model) => model.file)).size).toBe(SPIKE_MODELS.length);
    for (const model of SPIKE_MODELS) {
      expect(model.url).toMatch(/^https:\/\/huggingface\.co\/.+\.gguf$/u);
      expect(model.url.endsWith(model.file)).toBe(true);
      expect(model.bytes).toBeGreaterThan(1_000_000_000);
    }
  });
});
