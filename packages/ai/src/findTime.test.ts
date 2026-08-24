import { describe, expect, it } from 'vitest';
import type { FindTimeParse } from './findTime.ts';
import { buildFindTimePrompt, normalizeFindTime, parseFindTime } from './findTime.ts';
import { ModelUnavailableError } from './model.ts';
import type { LanguageModel, ModelStatus } from './model.ts';

const CONTEXT = { referenceDate: '2026-08-24', timeZone: 'Europe/Vienna' };

const fakeModel = (
  parse: FindTimeParse | (() => never),
  { status = 'ready' }: { status?: ModelStatus } = {},
): LanguageModel & { prompts: Array<string> } => {
  const prompts: Array<string> = [];
  return {
    generateJson: async ({ prompt }) => {
      prompts.push(prompt);
      return typeof parse === 'function' ? parse() : parse;
    },
    prompts,
    status: async () => status,
  };
};

describe('normalizeFindTime', () => {
  it('passes a full parse through', () => {
    const result = normalizeFindTime(
      {
        daysOfWeek: [1, 2],
        durationMinutes: 90,
        earliestTime: '8:00',
        latestTime: '12:00',
        title: 'focus',
        windowEndDate: '2026-08-30',
        windowStartDate: '2026-08-24',
      },
      CONTEXT,
    );
    expect(result).toEqual({
      constraints: {
        daysOfWeek: [1, 2],
        durationMinutes: 90,
        earliestTime: '08:00',
        latestTime: '12:00',
        windowEndDate: '2026-08-30',
        windowStartDate: '2026-08-24',
      },
      kind: 'parsed',
      title: 'focus',
    });
  });

  it('defaults the window to the coming week', () => {
    const result = normalizeFindTime({ durationMinutes: 60 }, CONTEXT);
    expect(result).toMatchObject({
      constraints: { windowEndDate: '2026-08-30', windowStartDate: '2026-08-24' },
      kind: 'parsed',
    });
  });

  it('rejects a missing or absurd duration', () => {
    expect(normalizeFindTime({}, CONTEXT).kind).toBe('rejected');
    expect(normalizeFindTime({ durationMinutes: 0 }, CONTEXT).kind).toBe('rejected');
    expect(normalizeFindTime({ durationMinutes: 13 * 60 }, CONTEXT).kind).toBe('rejected');
  });

  it('repairs an inverted or fake date window', () => {
    const result = normalizeFindTime(
      { durationMinutes: 60, windowEndDate: '2026-08-20', windowStartDate: '2026-08-24' },
      CONTEXT,
    );
    expect(result).toMatchObject({
      constraints: { windowEndDate: '2026-08-30', windowStartDate: '2026-08-24' },
    });
    const fake = normalizeFindTime({ durationMinutes: 60, windowStartDate: '2026-02-30' }, CONTEXT);
    expect(fake).toMatchObject({ constraints: { windowStartDate: '2026-08-24' } });
  });

  it('rejects an inverted time window and drops invalid weekdays', () => {
    expect(
      normalizeFindTime(
        { durationMinutes: 60, earliestTime: '14:00', latestTime: '09:00' },
        CONTEXT,
      ).kind,
    ).toBe('rejected');
    const result = normalizeFindTime({ daysOfWeek: [0, 3, 9], durationMinutes: 60 }, CONTEXT);
    expect(result).toMatchObject({ constraints: { daysOfWeek: [3] } });
  });

  it('strips placeholder titles', () => {
    const result = normalizeFindTime({ durationMinutes: 60, title: 'unknown' }, CONTEXT);
    expect(result).toMatchObject({ kind: 'parsed' });
    expect((result as { title?: string }).title).toBeUndefined();
  });
});

describe('parseFindTime', () => {
  it('resolves through the model and carries the reference date in the prompt', async () => {
    const model = fakeModel({ durationMinutes: 90 });
    const result = await parseFindTime(model, { phrase: '90 min focus', ...CONTEXT });
    expect(result.kind).toBe('parsed');
    expect(model.prompts[0]).toContain('Today is 2026-08-24');
    expect(model.prompts[0]).toContain('(today)');
  });

  it('rejects an empty phrase without calling the model', async () => {
    const model = fakeModel({ durationMinutes: 90 });
    const result = await parseFindTime(model, { phrase: '  ', ...CONTEXT });
    expect(result.kind).toBe('rejected');
    expect(model.prompts).toHaveLength(0);
  });

  it('throws when no model is available', async () => {
    const model = fakeModel({ durationMinutes: 90 }, { status: 'unavailable' });
    await expect(parseFindTime(model, { phrase: 'x', ...CONTEXT })).rejects.toThrow(
      ModelUnavailableError,
    );
  });

  it('turns a model failure into a rejection, not a crash', async () => {
    const model = fakeModel(() => {
      throw new Error('generation timed out');
    });
    const result = await parseFindTime(model, { phrase: '90 min focus', ...CONTEXT });
    expect(result.kind).toBe('rejected');
  });
});

describe('buildFindTimePrompt', () => {
  it('includes vocabulary anchors and the phrase', () => {
    const prompt = buildFindTimePrompt({ phrase: 'mornings next week', ...CONTEXT });
    expect(prompt).toContain('"mornings" is 08:00–12:00');
    expect(prompt).toContain('Phrase: mornings next week');
  });
});
