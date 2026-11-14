import type { LanguageModel } from '@calendar/ai';
import { describe, expect, it } from 'vite-plus/test';
import type { BenchDraft } from './check.ts';
import { plainResult } from './plain.ts';
import {
  buildTunedPrompt,
  buildTunedRefinePrompt,
  shortDraft,
  tunedAnswer,
  tunedExample,
  tunedTurn,
} from './tuned.ts';

// A Tuesday; the tests only ever compare against it.
const TODAY = '2026-11-10';

const dinner: BenchDraft = {
  choices: [],
  guests: [{ email: 'tom.baker@example.com' }],
  item: {
    kind: 'event',
    prefill: {
      assumedTime: true,
      date: '2026-11-13',
      endTime: '20:00',
      isAllDay: false,
      location: 'Blue Door',
      startTime: '19:00',
      title: 'Dinner with Teo',
    },
  },
  notes: 'bring the contract',
  reminders: [60],
};

const modelAnswering = (
  answer: unknown,
): { readonly model: LanguageModel; readonly prompts: Array<string> } => {
  const prompts: Array<string> = [];
  return {
    model: {
      generateJson: async ({ prompt }) => {
        prompts.push(prompt);
        if (answer instanceof Error) {
          throw answer;
        }
        return answer;
      },
      status: async () => 'ready',
    },
    prompts,
  };
};

describe('tunedAnswer', () => {
  it('writes the parts an answer has, in the one order, and leaves the rest out', () => {
    const answer = tunedAnswer({
      date: '2026-11-13',
      endTime: null,
      invite: [],
      kind: 'event',
      location: '  ',
      notes: undefined,
      nothingToSchedule: false,
      reminders: [60],
      repeat: { byDay: ['TU', 'TH'], count: null, freq: 'weekly', interval: 2 },
      startTime: '19:00',
      timeAssumed: true,
      title: 'Dinner with Teo',
      uninvite: ['Ben'],
    });
    expect(JSON.stringify(answer)).toBe(
      '{"kind":"event","title":"Dinner with Teo","date":"2026-11-13","startTime":"19:00","timeAssumed":true,"repeat":{"freq":"weekly","interval":2,"byDay":["TU","TH"]},"uninvite":["Ben"],"reminders":[60]}',
    );
  });

  it('writes a day and a repeat as said the way they came, the ruled-out days after the rule’s', () => {
    expect(
      JSON.stringify(
        tunedAnswer({
          date: '03-14',
          kind: 'event',
          repeat: { byDay: ['MO', 'TU', 'WE', 'TH', 'FR'], except: ['FR'], freq: 'weekly' },
          title: 'Standup',
        }),
      ),
    ).toBe(
      '{"kind":"event","title":"Standup","date":"03-14","repeat":{"freq":"weekly","byDay":["MO","TU","WE","TH","FR"],"except":["FR"]}}',
    );
  });

  it('keeps a first phrase’s empty list of notifications, and only a first phrase’s', () => {
    const none = { kind: 'event', reminders: [], startTime: '13:00', title: 'Lunch' };
    expect(JSON.stringify(tunedAnswer(none, { first: true }))).toBe(
      '{"kind":"event","title":"Lunch","startTime":"13:00","reminders":[]}',
    );
    expect(JSON.stringify(tunedAnswer(none))).toBe(
      '{"kind":"event","title":"Lunch","startTime":"13:00"}',
    );
  });

  it('leaves a flag that is off and a repeat that is none out', () => {
    expect(
      JSON.stringify(
        tunedAnswer({ kind: 'task', repeat: null, timeAssumed: false, title: 'Pay the rent' }),
      ),
    ).toBe('{"kind":"task","title":"Pay the rent"}');
  });

  it('is the one flag when there is nothing to schedule', () => {
    expect(tunedAnswer({ kind: 'event', nothingToSchedule: true, title: 'hm' })).toEqual({
      nothingToSchedule: true,
    });
  });

  it('is nothing for an answer that is no draft', () => {
    expect(tunedAnswer('dinner')).toBeUndefined();
    expect(tunedAnswer(null)).toBeUndefined();
    expect(tunedAnswer({ kind: 'event', title: ' ' })).toBeUndefined();
  });
});

describe('the tuned prompts', () => {
  it('asks a first phrase with the days and the words, and none of the conventions', () => {
    const prompt = buildTunedPrompt({
      phrase: 'Dinner with Teo next Friday',
      referenceDate: TODAY,
    });
    const lines = prompt.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('Tue 2026-11-10 (today), Wed 2026-11-11');
    expect(lines[1]).toContain('Mon 2026-11-23');
    expect(lines[2]).toBe('Phrase: Dinner with Teo next Friday');
    expect(prompt).not.toContain('Conventions');
  });

  it('shows a later turn the draft written short, what was said, and what is said now', () => {
    const prompt = buildTunedRefinePrompt({
      earlier: ['Dinner with Teo on Friday at Blue Door'],
      referenceDate: TODAY,
      state: {
        date: '2026-11-13',
        endTime: '20:00',
        guests: ['tom.baker@example.com'],
        kind: 'event',
        location: 'Blue Door',
        startTime: '19:00',
        timeAssumed: true,
        title: 'Dinner with Teo',
      },
      utterance: 'make it 8',
    });
    const lines = prompt.split('\n');
    expect(lines[2]).toBe(
      'Draft: {"kind":"event","title":"Dinner with Teo","date":"2026-11-13","startTime":"19:00","endTime":"20:00","timeAssumed":true,"location":"Blue Door","guests":["tom.baker@example.com"]}',
    );
    expect(lines[3]).toBe('Said before: ["Dinner with Teo on Friday at Blue Door"]');
    expect(lines[4]).toBe('Now: make it 8');
  });

  it('writes a draft short without touching the one it was given', () => {
    const state = { kind: 'event', location: '', title: 'Lunch' };
    expect(shortDraft(state)).toEqual({ kind: 'event', title: 'Lunch' });
    expect(state.location).toBe('');
  });
});

describe('tunedExample', () => {
  it('pairs a first phrase with the answer to learn', () => {
    const example = tunedExample(
      { draft: undefined, earlier: [], referenceDate: TODAY, text: 'Lunch tomorrow at 1' },
      {
        date: '2026-11-11',
        kind: 'event',
        nothingToSchedule: false,
        startTime: '13:00',
        title: 'Lunch',
      },
    );
    expect(example?.messages[0].content).toBe(
      buildTunedPrompt({ phrase: 'Lunch tomorrow at 1', referenceDate: TODAY }),
    );
    expect(example?.messages[1]).toEqual({
      content: '{"kind":"event","title":"Lunch","date":"2026-11-11","startTime":"13:00"}',
      role: 'assistant',
    });
  });

  it('shows a later turn the draft the bench holds', () => {
    const example = tunedExample(
      { draft: dinner, earlier: ['Dinner with Teo Friday'], referenceDate: TODAY, text: 'at 8' },
      { date: '2026-11-13', kind: 'event', startTime: '20:00', title: 'Dinner with Teo' },
    );
    expect(example?.messages[0].content).toContain(
      '"location":"Blue Door","guests":["tom.baker@example.com"],"notes":"bring the contract","reminders":[60]}',
    );
    expect(example?.messages[0].content.endsWith('Now: at 8')).toBe(true);
  });

  it('is nothing where the teacher gave no draft', () => {
    expect(
      tunedExample({ draft: undefined, earlier: [], referenceDate: TODAY, text: 'Lunch' }, 'no'),
    ).toBeUndefined();
  });
});

describe('tunedTurn', () => {
  it('takes a short answer through the plain arm’s code', async () => {
    const answer = { date: '2026-11-13', kind: 'event', startTime: '19:00', title: 'Dinner' };
    const { model, prompts } = modelAnswering(answer);
    const turn = { draft: undefined, earlier: [], referenceDate: TODAY, text: 'Dinner on Friday' };
    await expect(tunedTurn(model, turn)).resolves.toEqual(
      plainResult(answer, { draft: undefined, referenceDate: TODAY }),
    );
    expect(prompts).toEqual([
      buildTunedPrompt({ phrase: 'Dinner on Friday', referenceDate: TODAY }),
    ]);
  });

  it('changes a draft from the whole draft a later answer gives', async () => {
    const answer = {
      date: '2026-11-13',
      endTime: '21:00',
      kind: 'event',
      location: 'Blue Door',
      notes: 'bring the contract',
      reminders: [60],
      startTime: '20:00',
      title: 'Dinner with Teo',
    };
    const { model, prompts } = modelAnswering(answer);
    const result = await tunedTurn(model, {
      draft: dinner,
      earlier: ['Dinner with Teo Friday'],
      referenceDate: TODAY,
      text: 'make it 8',
    });
    expect(result).toEqual(plainResult(answer, { draft: dinner, referenceDate: TODAY }));
    expect(result.kind === 'parsed' && result.prefill.startTime).toBe('20:00');
    expect(prompts[0]).toContain('Now: make it 8');
  });

  it('works out a day and a repeat written as said before the plain arm’s code', async () => {
    const { model } = modelAnswering({
      date: '14',
      kind: 'event',
      repeat: { except: ['SU'], freq: 'daily' },
      startTime: '07:00',
      title: 'Yoga',
    });
    const result = await tunedTurn(model, {
      draft: undefined,
      earlier: [],
      referenceDate: TODAY,
      text: 'Yoga from the 14th every day at 7 but not on Sundays',
    });
    // The 14th is a Saturday: a day of the rule, so the repeat starts on it.
    expect(result).toMatchObject({
      kind: 'parsed',
      prefill: {
        date: '2026-11-14',
        recurrence: {
          byDay: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA'].map((weekday) => ({ weekday })),
          freq: 'weekly',
        },
        startTime: '07:00',
      },
    });
  });

  it('keeps a later turn’s bare day in the month of the draft', async () => {
    const { model } = modelAnswering({
      date: '20',
      kind: 'event',
      startTime: '19:00',
      title: 'Dinner with Teo',
    });
    const far: BenchDraft = {
      choices: [],
      guests: [],
      item: {
        kind: 'event',
        prefill: {
          date: '2027-03-14',
          endTime: '20:00',
          isAllDay: false,
          startTime: '19:00',
          title: 'Dinner with Teo',
        },
      },
    };
    const result = await tunedTurn(model, {
      draft: far,
      earlier: ['Dinner with Teo March 14'],
      referenceDate: TODAY,
      text: 'actually the 20th',
    });
    expect(result.kind === 'parsed' && result.prefill.date).toBe('2027-03-20');
  });

  it('turns down empty words, and a model that fails', async () => {
    const { model, prompts } = modelAnswering(new Error('the server answered HTTP 500'));
    const turn = { draft: undefined, earlier: [], referenceDate: TODAY };
    await expect(tunedTurn(model, { ...turn, text: '  ' })).resolves.toMatchObject({
      kind: 'rejected',
    });
    expect(prompts).toEqual([]);
    await expect(tunedTurn(model, { ...turn, text: 'Dinner' })).resolves.toEqual({
      kind: 'rejected',
      reason: "That couldn't be read — try rephrasing.",
    });
  });
});
