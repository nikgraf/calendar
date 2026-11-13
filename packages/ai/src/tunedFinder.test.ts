import { describe, expect, it } from 'vite-plus/test';
import type { LanguageModel, ModelStatus } from './model.ts';
import {
  buildTunedFinderPrompt,
  tunedFinder,
  tunedFinderAnswer,
  tunedFindTime,
} from './tunedFinder.ts';

// A Friday; every date below is relative to it.
const TODAY = '2026-11-13';
const ZONE = 'Europe/Vienna';

const modelOf = (
  answer: unknown,
  status: ModelStatus = 'ready',
): {
  readonly asked: Array<{ prompt: string; schema: unknown }>;
  readonly model: LanguageModel;
} => {
  const asked: Array<{ prompt: string; schema: unknown }> = [];
  return {
    asked,
    model: {
      generateJson: async ({ jsonSchema, prompt }) => {
        asked.push({ prompt, schema: jsonSchema });
        if (answer instanceof Error) {
          throw answer;
        }
        return answer;
      },
      status: async () => status,
    },
  };
};

describe('buildTunedFinderPrompt', () => {
  it('starts with its own first line, then the days and the words', () => {
    const lines = buildTunedFinderPrompt({
      phrase: 'an hour tomorrow',
      referenceDate: TODAY,
    }).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Free time as JSON.');
    expect(lines[1]).toMatch(/^Days: Fri 2026-11-13 \(today\), Sat 2026-11-14, /u);
    expect(lines[2]).toBe('Phrase: an hour tomorrow');
  });
});

describe('tunedFinderAnswer', () => {
  it('writes the fields in one order, the empty ones left out', () => {
    expect(
      JSON.stringify(
        tunedFinderAnswer({
          daysOfWeek: [],
          durationMinutes: 90,
          earliestTime: '',
          title: 'Focus',
          windowEndDate: '2026-11-14',
          windowStartDate: '2026-11-14',
        }),
      ),
    ).toBe(
      '{"durationMinutes":90,"windowStartDate":"2026-11-14","windowEndDate":"2026-11-14","title":"Focus"}',
    );
    expect(tunedFinderAnswer('90')).toBeUndefined();
    // A length of nothing is none.
    expect(tunedFinderAnswer({ durationMinutes: 0, title: 'Focus' })).toEqual({ title: 'Focus' });
  });
});

describe('tunedFindTime', () => {
  const input = {
    fallbackDurationMinutes: 45,
    phrase: 'an hour tomorrow',
    referenceDate: TODAY,
    timeZone: ZONE,
  };

  it('asks without a schema and reads the answer without the word rules', async () => {
    const { asked, model } = modelOf({
      durationMinutes: 60,
      windowEndDate: '2026-11-14',
      windowStartDate: '2026-11-14',
    });
    await expect(tunedFindTime(model, input)).resolves.toEqual({
      constraints: {
        durationMinutes: 60,
        windowEndDate: '2026-11-14',
        windowStartDate: '2026-11-14',
      },
      kind: 'parsed',
    });
    expect(asked[0]?.schema).toBeUndefined();
    expect(asked[0]?.prompt.startsWith('Free time as JSON.')).toBe(true);
  });

  it('fills what the answer leaves out with the code’s defaults: the finder’s length, the coming week', async () => {
    const { model } = modelOf({ title: 'Focus' });
    await expect(tunedFinder(model)({ ...input, phrase: 'time for focus' })).resolves.toEqual({
      constraints: { durationMinutes: 45, windowEndDate: '2026-11-19', windowStartDate: TODAY },
      kind: 'parsed',
      title: 'Focus',
    });
  });

  it('searches the finder’s own length for an answer of none', async () => {
    const { model } = modelOf({ durationMinutes: 0 });
    await expect(tunedFindTime(model, input)).resolves.toMatchObject({
      constraints: { durationMinutes: 45 },
    });
  });

  it('turns down an answer that is no object, a failed call, and empty words', async () => {
    await expect(tunedFindTime(modelOf('soon').model, input)).resolves.toMatchObject({
      kind: 'rejected',
    });
    await expect(tunedFindTime(modelOf(new Error('gone')).model, input)).resolves.toMatchObject({
      kind: 'rejected',
    });
    const { asked, model } = modelOf({});
    await expect(tunedFindTime(model, { ...input, phrase: '  ' })).resolves.toMatchObject({
      kind: 'rejected',
    });
    expect(asked).toEqual([]);
  });

  it('asks nothing of a model that is not ready, and says so', async () => {
    const { asked, model } = modelOf({}, 'not-ready');
    await expect(tunedFindTime(model, input)).rejects.toMatchObject({
      _tag: 'ModelUnavailableError',
    });
    expect(asked).toEqual([]);
  });
});
