import { describe, expect, it } from 'vite-plus/test';
import type { LanguageModel, ModelStatus } from './model.ts';
import { ModelUnavailableError } from './model.ts';
import type { QuickAddParse } from './quickAdd.ts';
import { buildRefinePrompt, normalizeRefine, parseRefine, type RefineDraft } from './refine.ts';

// 2026-08-22 is a Saturday.
const CONTEXT = { referenceDate: '2026-08-22', timeZone: 'Europe/Vienna' };

const DINNER: RefineDraft = {
  date: '2026-08-28',
  endTime: '20:00',
  isAllDay: false,
  startTime: '19:00',
  title: 'Dinner with Teo',
};

/** A model that copies the draft and applies a few changes, as asked. */
const refined = (parse: Partial<QuickAddParse>, utterance: string, draft: RefineDraft = DINNER) => {
  const result = normalizeRefine({ ...draft, ...parse }, { draft, utterance, ...CONTEXT });
  if (result.kind !== 'parsed') {
    throw new Error(`expected a parse, got: ${JSON.stringify(result)}`);
  }
  return result.prefill;
};

describe('normalizeRefine', () => {
  it('moves a stated time and keeps the length', () => {
    expect(refined({ endTime: '20:00', startTime: '20:00' }, 'make it 8pm')).toMatchObject({
      date: '2026-08-28',
      endTime: '21:00',
      startTime: '20:00',
    });
    // An open hour reads next to the draft's start, not by the model's choice.
    expect(refined({ startTime: '08:00' }, 'at 8 instead')).toMatchObject({
      endTime: '21:00',
      startTime: '20:00',
    });
    const standup = { ...DINNER, endTime: '09:15', startTime: '09:00', title: 'Standup' };
    expect(refined({ startTime: '20:00' }, 'at 8 instead', standup)).toMatchObject({
      endTime: '08:15',
      startTime: '08:00',
    });
    expect(refined({}, 'breakfast at 8')).toMatchObject({ startTime: '08:00' });
    const long = { ...DINNER, endTime: '21:30' };
    expect(refined({}, 'start at 7:30', long)).toMatchObject({
      endTime: '22:00',
      startTime: '19:30',
    });
  });

  it('takes both ends from a stated range', () => {
    expect(refined({}, 'from 6 to 7pm')).toMatchObject({ endTime: '19:00', startTime: '18:00' });
  });

  it('changes the length on its own', () => {
    expect(refined({}, 'make it two hours')).toMatchObject({
      endTime: '21:00',
      startTime: '19:00',
    });
    expect(refined({}, '90 minutes at 8')).toMatchObject({ endTime: '21:30', startTime: '20:00' });
  });

  it('moves the whole event on "later" and "earlier"', () => {
    // Review: "30 minutes later" shortened the event to 19:00–19:30.
    expect(
      refined({ endTime: '20:30', startTime: '19:30' }, 'move it 30 minutes later'),
    ).toMatchObject({ endTime: '20:30', startTime: '19:30' });
    expect(refined({}, 'eine Stunde früher')).toMatchObject({
      endTime: '19:00',
      startTime: '18:00',
    });
  });

  it('moves the day the utterance names and leaves one it does not', () => {
    expect(refined({ date: '2026-08-27' }, 'Thursday instead').date).toBe('2026-08-27');
    expect(refined({ date: '2026-08-25' }, 'Thursday instead').date).toBe('2026-08-27');
    expect(refined({}, 'tomorrow').date).toBe('2026-08-23');
    // A date the code cannot read but the model changed, and the words name one.
    expect(refined({ date: '2026-10-20' }, 'on Oct 20').date).toBe('2026-10-20');
    // The model moved the date without being asked.
    expect(refined({ date: '2026-09-04' }, 'call it team dinner').date).toBe('2026-08-28');
    // Review: a day the code leaves to the model on purpose is the model's to move.
    expect(refined({ date: '2026-08-23' }, 'morgen').date).toBe('2026-08-23');
    expect(refined({ date: '2026-09-05' }, 'two weeks from today').date).toBe('2026-09-05');
    expect(refined({ date: '2026-08-21' }, 'last Friday').date).toBe('2026-08-21');
  });

  it('keeps the times when the utterance says nothing about them, whatever the model did', () => {
    expect(refined({ endTime: '14:00', startTime: '13:00' }, 'call it team dinner')).toMatchObject({
      endTime: '20:00',
      startTime: '19:00',
      title: 'Dinner with Teo',
    });
    expect(refined({ title: 'Team dinner' }, 'call it team dinner').title).toBe('Team dinner');
  });

  it('switches to all day and back', () => {
    expect(refined({}, 'make it all day')).toMatchObject({ isAllDay: true, startTime: '00:00' });
    const allDay = { ...DINNER, endTime: '01:00', isAllDay: true, startTime: '00:00' };
    expect(refined({}, 'at 7pm', allDay)).toMatchObject({
      endTime: '20:00',
      isAllDay: false,
      startTime: '19:00',
    });
  });

  it('marks a time set by a meal word as assumed, and clears the mark on a stated one', () => {
    const lunch = { ...DINNER, title: 'Lunch' };
    expect(refined({}, 'make it lunch', lunch)).toMatchObject({
      assumedTime: true,
      startTime: '12:30',
    });
    expect(
      refined({}, 'at 1pm', { ...lunch, assumedTime: true } as RefineDraft),
    ).not.toHaveProperty('assumedTime');
  });

  it('takes a place the model extracted, keeps one it left alone, and clears one on request', () => {
    expect(refined({ location: "Luigi's" }, "at Luigi's").location).toBe("Luigi's");
    const placed = { ...DINNER, location: 'Figlmüller' };
    expect(refined({}, 'at 8', placed).location).toBe('Figlmüller');
    // Review: an omitted field used to mean "unchanged", so a place could never go.
    expect(refined({}, 'remove the location', placed).location).toBeUndefined();
    expect(refined({ location: 'Figlmüller' }, 'ohne Ort', placed).location).toBeUndefined();
  });

  it('changes nothing but the title on a rename', () => {
    // Review: "call it team dinner" moved a 21:00 dinner to the meal's default.
    const late = { ...DINNER, endTime: '22:00', startTime: '21:00' };
    expect(refined({ title: 'Team dinner' }, 'call it team dinner', late)).toEqual({
      ...late,
      title: 'Team dinner',
    });
    expect(refined({ date: '2026-08-28', title: 'Friday fun' }, 'name it Friday fun').date).toBe(
      '2026-08-28',
    );
  });

  it('sets, keeps and clears a repeat by the words', () => {
    expect(refined({ recurrence: { freq: 'weekly' } }, 'every week').recurrence).toEqual({
      freq: 'weekly',
    });
    // The model added a repeat nobody asked for.
    expect(refined({ recurrence: { freq: 'daily' } }, 'at 8').recurrence).toBeUndefined();
    const weekly = { ...DINNER, recurrence: { freq: 'weekly' as const } };
    expect(refined({}, 'at 8', weekly).recurrence).toEqual({ freq: 'weekly' });
    expect(refined({}, 'just once', weekly).recurrence).toBeUndefined();
    // Review: the editor's weekdays survive a change of interval.
    const days = {
      ...DINNER,
      recurrence: {
        byDay: [{ weekday: 'MO' as const }, { weekday: 'WE' as const }],
        freq: 'weekly' as const,
      },
    };
    expect(
      refined(
        { recurrence: { freq: 'weekly', interval: 2 } },
        'make it repeat every two weeks',
        days,
      ).recurrence,
    ).toEqual({ byDay: [{ weekday: 'MO' }, { weekday: 'WE' }], freq: 'weekly', interval: 2 });
    expect(refined({ recurrence: { freq: 'daily' } }, 'every day', days).recurrence).toEqual({
      freq: 'daily',
    });
  });

  it('keeps a span of days the form gave the draft, moved with its start', () => {
    const trip = { ...DINNER, endDate: '2026-08-30', isAllDay: true, title: 'Trip' };
    expect(refined({ date: '2026-08-27' }, 'Thursday instead', trip)).toMatchObject({
      date: '2026-08-27',
      endDate: '2026-08-29',
      isAllDay: true,
    });
    expect(refined({ title: 'Ski trip' }, 'call it ski trip', trip)).toMatchObject({
      endDate: '2026-08-30',
    });
    // An overnight draft keeps its next-day end through a rename.
    const night = { ...DINNER, endDate: '2026-08-29', endTime: '01:00', startTime: '23:00' };
    expect(refined({ location: 'Bar' }, 'at the Bar', night)).toMatchObject({
      endDate: '2026-08-29',
      endTime: '01:00',
      startTime: '23:00',
    });
    // Restated times read as one day.
    expect(refined({}, 'from 6 to 7pm', night).endDate).toBeUndefined();
  });

  it('shifts both ends of a draft over several days, its whole length kept', () => {
    const long = { ...DINNER, endDate: '2026-08-29', endTime: '10:00', startTime: '09:00' };
    expect(refined({}, '30 minutes later', long)).toMatchObject({
      date: '2026-08-28',
      endDate: '2026-08-29',
      endTime: '10:30',
      startTime: '09:30',
    });
    // Across midnight both ways.
    const night = { ...DINNER, endDate: '2026-08-29', endTime: '01:00', startTime: '23:00' };
    expect(refined({}, 'an hour later', night)).toMatchObject({
      date: '2026-08-29',
      endTime: '02:00',
      startTime: '00:00',
    });
    expect(refined({}, 'an hour later', night).endDate).toBeUndefined();
  });

  it('rejects a change that cannot be an event', () => {
    expect(
      normalizeRefine({ ...DINNER, title: '  ' }, { draft: DINNER, utterance: 'x', ...CONTEXT }),
    ).toMatchObject({ prefill: { title: 'Dinner with Teo' } });
    expect(
      normalizeRefine(DINNER, { draft: DINNER, utterance: 'at 11:59pm', ...CONTEXT }),
    ).toMatchObject({ kind: 'rejected' });
  });
});

const fakeModel = (
  parse: QuickAddParse | (() => never),
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

describe('parseRefine', () => {
  it('puts the draft and the change in the prompt and merges the answer', async () => {
    const model = fakeModel({ ...DINNER, startTime: '20:00' });
    const result = await parseRefine(model, { draft: DINNER, utterance: 'at 8pm', ...CONTEXT });
    expect(result).toMatchObject({
      kind: 'parsed',
      prefill: { endTime: '21:00', startTime: '20:00' },
    });
    const [prompt] = model.prompts;
    expect(prompt).toContain(`Current: ${JSON.stringify(DINNER)}`);
    expect(prompt).toContain('Change: at 8pm');
    expect(prompt).toContain('Sat 2026-08-22 (today)');
  });

  it('rejects an empty change without calling the model', async () => {
    const model = fakeModel(DINNER);
    expect(await parseRefine(model, { draft: DINNER, utterance: '  ', ...CONTEXT })).toMatchObject({
      kind: 'rejected',
    });
    expect(model.prompts).toHaveLength(0);
  });

  it('survives a failing model and signals an unavailable one', async () => {
    expect(
      await parseRefine(
        fakeModel(() => {
          throw new Error('timed out');
        }),
        { draft: DINNER, utterance: 'at 8', ...CONTEXT },
      ),
    ).toMatchObject({ kind: 'rejected' });
    await expect(
      parseRefine(fakeModel(DINNER, { status: 'unavailable' }), {
        draft: DINNER,
        utterance: 'at 8',
        ...CONTEXT,
      }),
    ).rejects.toThrow(ModelUnavailableError);
  });
});

describe('buildRefinePrompt', () => {
  it('asks for the whole event back with only the change applied', () => {
    const prompt = buildRefinePrompt({ draft: DINNER, utterance: 'Thursday', ...CONTEXT });
    expect(prompt).toContain('copy');
    expect(prompt.endsWith('Change: Thursday')).toBe(true);
  });
});
