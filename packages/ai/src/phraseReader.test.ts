import { describe, expect, it } from 'vite-plus/test';
import type { LanguageModel, ModelStatus } from './model.ts';
import { tunedReader } from './phraseReader.ts';
import { answerResult, type TurnDraft } from './tunedResult.ts';

// A Thursday; every date below is worked out from it.
const TODAY = '2026-11-12';
const ZONE = 'Europe/Vienna';

const modelOf = (
  answer: unknown,
  status: ModelStatus = 'ready',
): { readonly model: LanguageModel; readonly prompts: Array<string> } => {
  const prompts: Array<string> = [];
  return {
    model: {
      generateJson: async ({ prompt }) => {
        prompts.push(prompt);
        return answer;
      },
      status: async () => status,
    },
    prompts,
  };
};

const dinner: TurnDraft = {
  guests: [],
  kind: 'event',
  notes: 'window table',
  prefill: {
    date: '2026-11-13',
    endTime: '20:00',
    isAllDay: false,
    startTime: '19:00',
    title: 'Dinner',
  },
  reminders: [30],
};

describe('tunedReader, a first phrase', () => {
  it('asks nothing of a model that is not ready, and says so', async () => {
    const { model, prompts } = modelOf({}, 'not-ready');
    await expect(
      tunedReader(model).first({ phrase: 'Lunch at 1', referenceDate: TODAY, timeZone: ZONE }),
    ).rejects.toMatchObject({ _tag: 'ModelUnavailableError' });
    expect(prompts).toEqual([]);
  });

  it('puts words that name no day on the day on show', async () => {
    const { model } = modelOf({ date: TODAY, kind: 'event', startTime: '13:00', title: 'Lunch' });
    const result = await tunedReader(model).first({
      fallbackDate: '2026-11-20',
      phrase: 'Lunch at 1',
      referenceDate: TODAY,
      timeZone: ZONE,
    });
    expect(result).toMatchObject({ kind: 'parsed', prefill: { date: '2026-11-20' } });
  });

  it('keeps today where the words say it, and a day the model gave for other words', async () => {
    const today = modelOf({ date: TODAY, kind: 'event', startTime: '13:00', title: 'Lunch' });
    await expect(
      tunedReader(today.model).first({
        fallbackDate: '2026-11-20',
        phrase: 'Lunch today at 1',
        referenceDate: TODAY,
        timeZone: ZONE,
      }),
    ).resolves.toMatchObject({ prefill: { date: TODAY } });
    const friday = modelOf({ date: '2026-11-13', kind: 'event', title: 'Lunch' });
    await expect(
      tunedReader(friday.model).first({
        fallbackDate: '2026-11-20',
        phrase: 'Lunch on Friday',
        referenceDate: TODAY,
        timeZone: ZONE,
      }),
    ).resolves.toMatchObject({ prefill: { date: '2026-11-13' } });
  });
  it('starts a repeat and ends a night from the day on show', async () => {
    const gym = modelOf({
      date: TODAY,
      kind: 'event',
      repeat: { byDay: ['TU', 'TH'], freq: 'weekly' },
      startTime: '19:00',
      title: 'Gym',
    });
    const repeat = await tunedReader(gym.model).first({
      fallbackDate: '2026-11-15',
      phrase: 'Gym every Tuesday and Thursday at 7',
      referenceDate: TODAY,
      timeZone: ZONE,
    });
    // The Sunday on show is no day of the rule: it starts on the Tuesday after.
    expect(repeat).toMatchObject({ prefill: { date: '2026-11-17' } });
    const party = modelOf({
      date: TODAY,
      endTime: '02:00',
      kind: 'event',
      startTime: '22:00',
      title: 'Party',
    });
    await expect(
      tunedReader(party.model).first({
        fallbackDate: '2026-11-15',
        phrase: 'Party 10pm to 2am',
        referenceDate: TODAY,
        timeZone: ZONE,
      }),
    ).resolves.toMatchObject({ prefill: { date: '2026-11-15', endDate: '2026-11-16' } });
  });
});

describe('tunedReader, a later turn', () => {
  it('marks a turn whose words gave the day, even where it is the draft’s', async () => {
    const { model } = modelOf({
      ...dinner.prefill,
      kind: 'event',
      notes: 'window table',
      reminders: [30],
    });
    const reader = tunedReader(model);
    const input = {
      draft: dinner,
      referenceDate: TODAY,
      said: ['Dinner tomorrow at 7'],
      timeZone: ZONE,
    };
    await expect(reader.change({ ...input, utterance: 'on Friday' })).resolves.toMatchObject({
      saidDay: true,
    });
    await expect(reader.change({ ...input, utterance: 'with Teo' })).resolves.not.toHaveProperty(
      'saidDay',
    );
  });

  it('shows no long notes, so the answer’s lack of them changes nothing', async () => {
    const long = { ...dinner, notes: 'x'.repeat(400) };
    const { model, prompts } = modelOf({ ...dinner.prefill, kind: 'event', reminders: [30] });
    const result = await tunedReader(model).change({
      draft: long,
      referenceDate: TODAY,
      said: [],
      timeZone: ZONE,
      utterance: 'at 8',
    });
    expect(prompts[0]).not.toContain('xxxx');
    expect(result).not.toHaveProperty('notes');
    // Notes it was not shown can only be added to: replacing or clearing a long description is the Form's.
    const added = modelOf({ ...dinner.prefill, kind: 'event', notes: 'parking at the back' });
    await expect(
      tunedReader(added.model).change({
        draft: long,
        referenceDate: TODAY,
        said: [],
        timeZone: ZONE,
        utterance: 'add a note: parking at the back',
      }),
    ).resolves.toMatchObject({ notes: { kind: 'add', text: 'parking at the back' } });
  });

  it('shows the newest earlier turns only', async () => {
    const { model, prompts } = modelOf({ ...dinner.prefill, kind: 'event' });
    await tunedReader(model).change({
      draft: dinner,
      referenceDate: TODAY,
      said: ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'],
      timeZone: ZONE,
      utterance: 'at 8',
    });
    expect(prompts[0]).toContain('Said before: ["three","four","five","six","seven","eight"]');
  });
});

describe('answerResult', () => {
  it('takes off and adds notifications one by one, never clearing what it was not shown', () => {
    const result = answerResult(
      { ...dinner.prefill, kind: 'event', reminders: [60] },
      { draft: dinner, referenceDate: TODAY },
    );
    expect(result).toMatchObject({ reminders: { add: [60], clear: false, remove: [30] } });
  });

  it('takes every notification off for an answer that has none, an unseen email one too', () => {
    expect(
      answerResult({ ...dinner.prefill, kind: 'event' }, { draft: dinner, referenceDate: TODAY }),
    ).toMatchObject({ reminders: { add: [], clear: true, remove: [] } });
  });

  it('shows a calendar’s default notifications as the draft’s, and puts the answer’s in their place', async () => {
    const byDefault: TurnDraft = { ...dinner, defaultReminders: [10], reminders: undefined };
    const unchanged = answerResult(
      { ...dinner.prefill, kind: 'event', reminders: [10] },
      { draft: byDefault, referenceDate: TODAY },
    );
    expect(unchanged).not.toHaveProperty('reminders');
    expect(
      answerResult(
        { ...dinner.prefill, kind: 'event' },
        { draft: byDefault, referenceDate: TODAY },
      ),
    ).toMatchObject({ reminders: { add: [], clear: true, remove: [] } });
    expect(
      answerResult(
        { ...dinner.prefill, kind: 'event', reminders: [10, 60] },
        { draft: byDefault, referenceDate: TODAY },
      ),
    ).toMatchObject({ reminders: { add: [10, 60], clear: true, remove: [] } });
    const { model, prompts } = modelOf({ ...dinner.prefill, kind: 'event', reminders: [10] });
    await tunedReader(model).change({
      draft: byDefault,
      referenceDate: TODAY,
      said: [],
      timeZone: ZONE,
      utterance: 'at 8',
    });
    expect(prompts[0]).toContain('"reminders":[10]');
  });

  it('moves a span of days with its start, and lets it go for new times', () => {
    const span: TurnDraft = {
      ...dinner,
      prefill: {
        ...dinner.prefill,
        endDate: '2026-11-15',
        endTime: '01:00',
        isAllDay: true,
        startTime: '00:00',
      },
    };
    const moved = answerResult(
      { date: '2026-11-20', kind: 'event', title: 'Dinner' },
      { draft: span, referenceDate: TODAY },
    );
    expect(moved).toMatchObject({ prefill: { date: '2026-11-20', endDate: '2026-11-22' } });
    const timed = answerResult(
      { date: '2026-11-20', kind: 'event', startTime: '19:00', title: 'Dinner' },
      { draft: span, referenceDate: TODAY },
    );
    expect(timed).not.toHaveProperty('prefill.endDate');
  });
  it('keeps an overnight draft’s span through a turn that leaves its times alone', () => {
    const overnight: TurnDraft = {
      ...dinner,
      prefill: { ...dinner.prefill, endDate: '2026-11-14', endTime: '02:00', startTime: '22:00' },
    };
    const renamed = answerResult(
      { date: '2026-11-13', endTime: '02:00', kind: 'event', startTime: '22:00', title: 'Party' },
      { draft: overnight, referenceDate: TODAY },
    );
    expect(renamed).toMatchObject({
      prefill: { date: '2026-11-13', endDate: '2026-11-14', endTime: '02:00', startTime: '22:00' },
    });
    const moved = answerResult(
      { date: '2026-11-20', endTime: '02:00', kind: 'event', startTime: '22:00', title: 'Party' },
      { draft: overnight, referenceDate: TODAY },
    );
    expect(moved).toMatchObject({ prefill: { date: '2026-11-20', endDate: '2026-11-21' } });
  });

  it('reads an end before the start as past midnight, and one at the start as no end', () => {
    expect(
      answerResult(
        { date: '2026-11-13', endTime: '02:00', kind: 'event', startTime: '22:00', title: 'Party' },
        { draft: undefined, referenceDate: TODAY },
      ),
    ).toMatchObject({ prefill: { endDate: '2026-11-14', endTime: '02:00' } });
    const same = answerResult(
      { date: '2026-11-13', endTime: '09:00', kind: 'event', startTime: '09:00', title: 'Call' },
      { draft: undefined, referenceDate: TODAY },
    );
    expect(same).toMatchObject({ prefill: { endTime: '10:00' } });
    expect(same).not.toHaveProperty('prefill.endDate');
  });

  it('keeps a draft’s length when only its start moves, across midnight too', () => {
    const moved = answerResult(
      { date: '2026-11-13', endTime: '20:00', kind: 'event', startTime: '23:30', title: 'Dinner' },
      { draft: dinner, referenceDate: TODAY },
    );
    expect(moved).toMatchObject({
      prefill: { endDate: '2026-11-14', endTime: '00:30', startTime: '23:30' },
    });
    const night: TurnDraft = {
      ...dinner,
      prefill: { ...dinner.prefill, endDate: '2026-11-14', endTime: '08:00', startTime: '18:00' },
    };
    const later = answerResult(
      { date: '2026-11-13', endTime: '09:00', kind: 'event', startTime: '19:00', title: 'Shift' },
      { draft: night, referenceDate: TODAY },
    );
    // A draft that crossed midnight keeps crossing it, past the twelve hours.
    expect(later).toMatchObject({ prefill: { endDate: '2026-11-14', endTime: '09:00' } });
  });

  it('keeps a timed span of days when both of its times move', () => {
    const trip: TurnDraft = {
      ...dinner,
      prefill: { ...dinner.prefill, endDate: '2026-11-14', endTime: '10:00', startTime: '09:00' },
    };
    const later = answerResult(
      { date: '2026-11-13', endTime: '11:00', kind: 'event', startTime: '10:00', title: 'Trip' },
      { draft: trip, referenceDate: TODAY },
    );
    expect(later).toMatchObject({
      prefill: { date: '2026-11-13', endDate: '2026-11-14', endTime: '11:00', startTime: '10:00' },
    });
    // Times given to a span of whole days make it a timed day of its own.
    const days: TurnDraft = {
      ...dinner,
      prefill: { ...dinner.prefill, endDate: '2026-11-15', isAllDay: true, startTime: '00:00' },
    };
    const timed = answerResult(
      { date: '2026-11-13', endTime: '11:00', kind: 'event', startTime: '10:00', title: 'Trip' },
      { draft: days, referenceDate: TODAY },
    );
    expect(timed).not.toHaveProperty('prefill.endDate');
  });
});
