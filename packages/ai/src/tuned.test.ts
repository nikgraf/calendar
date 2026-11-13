import { describe, expect, it } from 'vite-plus/test';
import type { LanguageModel } from './model.ts';
import { tunedPrompt, tunedTurn } from './tuned.ts';
import type { TurnDraft } from './tunedResult.ts';

// A Thursday; every date below is worked out from it.
const TODAY = '2026-11-12';

const lunch: TurnDraft = {
  guests: ['tom.baker@example.com'],
  kind: 'event',
  prefill: {
    date: '2026-11-13',
    endTime: '14:00',
    isAllDay: false,
    location: 'Café Roth',
    startTime: '13:00',
    title: 'Lunch with Tom',
  },
  reminders: [30],
};

const answering = (answer: unknown): { model: LanguageModel; prompts: Array<string> } => {
  const prompts: Array<string> = [];
  return {
    model: {
      generateJson: async ({ jsonSchema, prompt }) => {
        expect(jsonSchema).toBeUndefined();
        prompts.push(prompt);
        return answer;
      },
      status: async () => 'ready',
    },
    prompts,
  };
};

describe('the tuned prompts', () => {
  // The model was trained on these bytes: a change here needs a model trained again.
  it('ask a first phrase in the bytes the model was trained on', () => {
    expect(
      tunedPrompt({
        draft: undefined,
        earlier: [],
        referenceDate: TODAY,
        text: 'Lunch tomorrow at 1',
      }),
    ).toBe(
      [
        'Calendar entry as JSON.',
        'Days: Thu 2026-11-12 (today), Fri 2026-11-13, Sat 2026-11-14, Sun 2026-11-15, Mon 2026-11-16, Tue 2026-11-17, Wed 2026-11-18, Thu 2026-11-19, Fri 2026-11-20, Sat 2026-11-21, Sun 2026-11-22, Mon 2026-11-23, Tue 2026-11-24, Wed 2026-11-25',
        'Phrase: Lunch tomorrow at 1',
      ].join('\n'),
    );
  });

  it('ask a later turn with the draft written short, what was said and what is said now', () => {
    expect(
      tunedPrompt({
        draft: lunch,
        earlier: ['Lunch with Tom tomorrow at 1'],
        referenceDate: TODAY,
        text: 'make it 2',
      })
        .split('\n')
        .slice(2),
    ).toEqual([
      'Draft: {"kind":"event","title":"Lunch with Tom","date":"2026-11-13","startTime":"13:00","endTime":"14:00","location":"Café Roth","guests":["tom.baker@example.com"],"reminders":[30]}',
      'Said before: ["Lunch with Tom tomorrow at 1"]',
      'Now: make it 2',
    ]);
  });
});

describe('tunedTurn', () => {
  it('works out a day said by its number before it reads the answer', async () => {
    const { model, prompts } = answering({ date: '03-14', kind: 'event', title: 'Party' });
    const result = await tunedTurn(model, {
      draft: undefined,
      earlier: [],
      referenceDate: TODAY,
      text: 'Party on March 14',
    });
    expect(result).toMatchObject({
      kind: 'parsed',
      prefill: { date: '2027-03-14', isAllDay: true },
    });
    expect(prompts).toHaveLength(1);
  });

  it('keeps a later turn’s bare day in the draft’s month', async () => {
    const { model } = answering({
      date: '20',
      kind: 'event',
      startTime: '13:00',
      title: 'Lunch with Tom',
    });
    const result = await tunedTurn(model, {
      draft: { ...lunch, prefill: { ...lunch.prefill, date: '2027-03-14' } },
      earlier: ['Lunch with Tom March 14 at 1'],
      referenceDate: TODAY,
      text: 'actually the 20th',
    });
    expect(result.kind === 'parsed' && result.prefill.date).toBe('2027-03-20');
  });

  it('turns down empty words without asking, and a model that fails', async () => {
    const { model, prompts } = answering({});
    await expect(
      tunedTurn(model, { draft: undefined, earlier: [], referenceDate: TODAY, text: ' ' }),
    ).resolves.toMatchObject({ kind: 'rejected' });
    expect(prompts).toEqual([]);
    const failing: LanguageModel = {
      generateJson: async () => {
        throw new Error('down');
      },
      status: async () => 'ready',
    };
    await expect(
      tunedTurn(failing, { draft: undefined, earlier: [], referenceDate: TODAY, text: 'Lunch' }),
    ).resolves.toEqual({ kind: 'rejected', reason: "That couldn't be read — try rephrasing." });
  });
});
