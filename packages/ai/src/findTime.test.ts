import { describe, expect, it } from 'vite-plus/test';
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

// The finder's own duration stands in for one the phrase does not state.
const withPhrase = (parse: FindTimeParse, phrase: string, fallbackDurationMinutes = 60) =>
  normalizeFindTime(parse, { fallbackDurationMinutes, phrase, ...CONTEXT });

const constraintsOf = (result: ReturnType<typeof normalizeFindTime>) => {
  if (result.kind !== 'parsed') {
    throw new Error(result.reason);
  }
  return result.constraints;
};

describe('normalizeFindTime holds the parse against the phrase', () => {
  it('searches the duration on show unless the phrase says how long', () => {
    // Observed: "dinner with Teo next week" came back as 120 minutes.
    expect(withPhrase({ durationMinutes: 120 }, 'dinner with Teo next week')).toMatchObject({
      constraints: { durationMinutes: 60 },
    });
    expect(withPhrase({ durationMinutes: 90 }, '90 min focus')).toMatchObject({
      constraints: { durationMinutes: 90 },
    });
    expect(withPhrase({}, 'dinner next week')).toMatchObject({
      constraints: { durationMinutes: 60 },
    });
  });

  it('counts weekdays only when the phrase names them', () => {
    // Observed: daysOfWeek [2] in every answer.
    const tuesday = { daysOfWeek: [2], durationMinutes: 60 };
    expect(constraintsOf(withPhrase(tuesday, 'dinner next week'))).not.toHaveProperty('daysOfWeek');
    expect(withPhrase(tuesday, 'Tuesdays')).toMatchObject({ constraints: { daysOfWeek: [2] } });
    expect(withPhrase({ daysOfWeek: [2], durationMinutes: 60 }, 'weekdays')).toMatchObject({
      constraints: { daysOfWeek: [1, 2, 3, 4, 5] },
    });
  });

  it('bounds a named meal or part of the day by its window', () => {
    // Observed: dinner came back as 12:00–17:00.
    const afternoon = { durationMinutes: 60, earliestTime: '12:00', latestTime: '17:00' };
    expect(withPhrase(afternoon, 'dinner with Teo next week')).toMatchObject({
      constraints: { earliestTime: '18:00', latestTime: '21:00' },
    });
    expect(withPhrase(afternoon, 'mornings')).toMatchObject({
      constraints: { earliestTime: '08:00', latestTime: '12:00' },
    });
    // A stated clock time keeps the model's bounds; nothing stated drops them.
    expect(withPhrase({ durationMinutes: 60, earliestTime: '17:00' }, 'after 5pm')).toMatchObject({
      constraints: { earliestTime: '17:00' },
    });
    const dropped = constraintsOf(withPhrase(afternoon, '90 min focus'));
    expect(dropped).not.toHaveProperty('earliestTime');
    expect(dropped).not.toHaveProperty('latestTime');
  });

  it('takes a window the phrase names in words', () => {
    // 2026-08-24 is a Monday: next week is the 31st to the 6th, whatever the model said.
    expect(
      withPhrase(
        { durationMinutes: 60, windowEndDate: '2026-08-31', windowStartDate: '2026-08-24' },
        'dinner with Teo next week',
      ),
    ).toMatchObject({
      constraints: { windowEndDate: '2026-09-06', windowStartDate: '2026-08-31' },
    });
    expect(withPhrase({ durationMinutes: 60 }, 'an hour tomorrow')).toMatchObject({
      constraints: { windowEndDate: '2026-08-25', windowStartDate: '2026-08-25' },
    });
  });

  it('reads a timestamp in a date field for its day', () => {
    // Observed: "2026-08-26T08:00:00+01:00" as a window start.
    expect(
      withPhrase(
        { durationMinutes: 60, windowStartDate: '2026-08-26T08:00:00+01:00' },
        '90 min focus',
      ),
    ).toMatchObject({ constraints: { windowStartDate: '2026-08-26' } });
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
    expect(prompt).toContain('"dinner" 18:00–21:00');
    expect(prompt).toContain('Phrase: mornings next week');
  });
});
