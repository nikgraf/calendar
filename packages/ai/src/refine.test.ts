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
    // A place the words do not say — echoed, or made up — leaves the draft's.
    expect(refined({ location: 'Figlmüller' }, 'at 8', placed).location).toBe('Figlmüller');
    expect(refined({ location: "Bob's house" }, 'at 8', placed).location).toBe('Figlmüller');
    expect(refined({ location: 'Teo' }, 'at 8').location).toBeUndefined();
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

  it('returns who the words invite or take off, beside the draft', () => {
    const result = normalizeRefine(
      { ...DINNER, title: 'Dinner with Teo, invite Anna' },
      {
        draft: DINNER,
        people: ['Anna', 'Tom'],
        utterance: 'also invite Anna and remove Tom',
        ...CONTEXT,
      },
    );
    expect(result).toEqual({
      invite: ['Anna'],
      kind: 'parsed',
      prefill: DINNER,
      uninvite: ['Tom'],
    });
    // Words about guests leave the title alone: the model wrote the guest into it.
    expect(
      normalizeRefine(
        { ...DINNER, title: 'Dinner with Teo and Anna' },
        { draft: DINNER, people: ['Anna'], utterance: 'also invite Anna', ...CONTEXT },
      ),
    ).toEqual({ invite: ['Anna'], kind: 'parsed', prefill: DINNER });
    // Beside guests, a place only as the words say it.
    expect(
      normalizeRefine(
        { ...DINNER, location: "Bob's house", startTime: '20:00' },
        { draft: DINNER, people: ['Bob'], utterance: 'make it 8pm and invite Bob', ...CONTEXT },
      ),
    ).toEqual({
      invite: ['Bob'],
      kind: 'parsed',
      prefill: { ...DINNER, endTime: '21:00', startTime: '20:00' },
    });
    expect(
      refined({ location: "Luigi's" }, "invite Bob and meet at Luigi's", DINNER).location,
    ).toBe("Luigi's");
    // A "remove" that takes no one off leaves the title and place rules alone.
    expect(
      normalizeRefine(
        { ...DINNER, location: 'Café Central', title: 'Dinner' },
        { draft: DINNER, utterance: 'remove the reminder, dinner at Café Central', ...CONTEXT },
      ),
    ).toMatchObject({ prefill: { location: 'Café Central', title: 'Dinner' } });
    // A rename takes the title and whom it invites, the invitation out of the title.
    expect(
      normalizeRefine(
        { ...DINNER, title: 'Team dinner and invite Anna' },
        {
          draft: DINNER,
          people: ['Anna'],
          utterance: 'call it team dinner and invite Anna',
          ...CONTEXT,
        },
      ),
    ).toEqual({ invite: ['Anna'], kind: 'parsed', prefill: { ...DINNER, title: 'Team dinner' } });
    // No cue, no people.
    expect(
      normalizeRefine(DINNER, { draft: DINNER, people: ['Teo'], utterance: 'at 8', ...CONTEXT }),
    ).not.toHaveProperty('invite');
  });

  it('leaves a to-do’s words about people to its title', () => {
    // Review: "call it Invite Tom to dinner" renamed a to-do "Dinner".
    expect(
      normalizeRefine(
        { ...DINNER, title: 'Invite Tom to dinner' },
        {
          draft: DINNER,
          guests: false,
          people: ['Tom'],
          utterance: 'call it Invite Tom to dinner',
          ...CONTEXT,
        },
      ),
    ).toEqual({ kind: 'parsed', prefill: { ...DINNER, title: 'Invite Tom to dinner' } });
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

  it('reads the repeat from the words, not from what the model made of them', () => {
    // Observed (the bench): "every week" answered as one week — count 1,
    // an end a week on — and the draft lost the repeat.
    expect(
      refined(
        { recurrence: { count: 1, freq: 'weekly', interval: 1, untilDate: '2026-09-04' } },
        'every week',
      ).recurrence,
    ).toEqual({ freq: 'weekly' });
    expect(
      refined({ recurrence: { count: 2, freq: 'weekly', interval: 14 } }, 'every two weeks')
        .recurrence,
    ).toEqual({ freq: 'weekly', interval: 2 });
    // "every weekday": the days are the words', over the editor's.
    const weekdays = [
      { weekday: 'MO' },
      { weekday: 'TU' },
      { weekday: 'WE' },
      { weekday: 'TH' },
      { weekday: 'FR' },
    ];
    const days = {
      ...DINNER,
      recurrence: {
        byDay: [{ weekday: 'MO' as const }, { weekday: 'WE' as const }],
        freq: 'weekly' as const,
      },
    };
    expect(
      refined({ recurrence: { count: 5, freq: 'weekly' } }, 'every weekday', days),
    ).toMatchObject({ date: '2026-08-28', recurrence: { byDay: weekdays, freq: 'weekly' } });
    // Said of a Saturday draft, it starts on the Monday.
    const saturday = { ...DINNER, date: '2026-08-29' };
    expect(refined({ recurrence: { freq: 'weekly' } }, 'every weekday', saturday)).toMatchObject({
      date: '2026-08-31',
      recurrence: { byDay: weekdays, freq: 'weekly' },
    });
    // "stop repeating" came back as a daily rule of nothing.
    const weekly = { ...DINNER, recurrence: { freq: 'weekly' as const } };
    expect(
      refined(
        { recurrence: { count: 0, freq: 'daily', interval: 0, untilDate: '2026-08-28' } },
        'stop repeating',
        weekly,
      ).recurrence,
    ).toBeUndefined();
  });

  it("keeps what the words leave unsaid of the draft's own repeat", () => {
    // Review: "every two weeks" on a rule that ends in December kept the
    // end before this change (the model copied it); the count the same.
    const ending = { ...DINNER, recurrence: { freq: 'weekly' as const, untilDate: '2026-12-31' } };
    expect(
      refined({ recurrence: { freq: 'weekly', interval: 2 } }, 'every two weeks', ending)
        .recurrence,
    ).toEqual({ freq: 'weekly', interval: 2, untilDate: '2026-12-31' });
    const counted = { ...DINNER, recurrence: { count: 10, freq: 'weekly' as const } };
    expect(refined({ recurrence: { freq: 'daily' } }, 'every day', counted).recurrence).toEqual({
      count: 10,
      freq: 'daily',
    });
    // The words' own count or end replaces it.
    expect(
      refined({ recurrence: { freq: 'weekly' } }, 'every week for 4 weeks', ending).recurrence,
    ).toEqual({ count: 4, freq: 'weekly' });
    // Review: one weekday the words name moves the rule off the editor's
    // days — Thursday, not an odd first Thursday before Mondays and
    // Wednesdays.
    const days = {
      ...DINNER,
      date: '2026-08-24',
      recurrence: {
        byDay: [{ weekday: 'MO' as const }, { weekday: 'WE' as const }],
        freq: 'weekly' as const,
      },
    };
    expect(refined({ date: '2026-08-27' }, 'every Thursday', days)).toMatchObject({
      date: '2026-08-27',
      recurrence: { freq: 'weekly' },
    });
    expect(
      refined({ date: '2026-08-27' }, 'every Thursday', days).recurrence?.byDay,
    ).toBeUndefined();
    // A turn about guests leaves a repeat with a gap and an end alone.
    const full = {
      ...DINNER,
      recurrence: {
        byDay: [{ weekday: 'MO' as const }],
        freq: 'weekly' as const,
        interval: 2,
        untilDate: '2026-12-31',
      },
    };
    expect(refined({}, 'invite each of the team leads', full).recurrence).toEqual(full.recurrence);
    // Review: a span over the editor's days ends the rule, it does not
    // count them ("every week for 6 weeks" on Mondays and Wednesdays).
    expect(
      refined({ recurrence: { count: 6, freq: 'weekly' } }, 'every week for 6 weeks', days)
        .recurrence,
    ).toEqual({
      byDay: [{ weekday: 'MO' }, { weekday: 'WE' }],
      freq: 'weekly',
      untilDate: '2026-10-04',
    });
    // Review: a count or span said alone, and "repeat it 10 times", keep
    // the kind, the gap and the days, whatever the model made of them.
    const gapped = { ...days, recurrence: { ...days.recurrence, interval: 2 } };
    expect(
      refined({ recurrence: { count: 10, freq: 'daily' } }, 'repeat it 10 times', gapped)
        .recurrence,
    ).toEqual({
      byDay: [{ weekday: 'MO' }, { weekday: 'WE' }],
      count: 10,
      freq: 'weekly',
      interval: 2,
    });
    expect(
      refined({ recurrence: { count: 10, freq: 'weekly' } }, '10 times', gapped).recurrence,
    ).toEqual({
      byDay: [{ weekday: 'MO' }, { weekday: 'WE' }],
      count: 10,
      freq: 'weekly',
      interval: 2,
    });
    const weeklyOnly = { ...DINNER, recurrence: { freq: 'weekly' as const } };
    expect(refined({}, 'for 6 weeks', weeklyOnly).recurrence).toEqual({
      count: 6,
      freq: 'weekly',
    });
    expect(refined({}, 'for 6 weeks', days).recurrence).toEqual({
      byDay: [{ weekday: 'MO' }, { weekday: 'WE' }],
      freq: 'weekly',
      untilDate: '2026-10-04',
    });
    // Codex: "forever" takes the draft's end away; "from every week to
    // every month" means monthly.
    const until = { ...DINNER, recurrence: { freq: 'weekly' as const, untilDate: '2026-12-31' } };
    expect(
      refined({ recurrence: { freq: 'weekly' } }, 'repeat weekly forever', until).recurrence,
    ).toEqual({
      freq: 'weekly',
    });
    expect(
      refined({ recurrence: { freq: 'monthly' } }, 'change from every week to every month', until)
        .recurrence,
    ).toEqual({ freq: 'monthly', untilDate: '2026-12-31' });
    // Codex: a date the words move on their own stays where they put it,
    // the rule's days kept as they were.
    expect(refined({ date: '2026-08-27' }, 'move it to Thursday', days)).toMatchObject({
      date: '2026-08-27',
      recurrence: { byDay: [{ weekday: 'MO' }, { weekday: 'WE' }], freq: 'weekly' },
    });
    // Review: a date the words move past the rule's end keeps the rule;
    // the editor says the end is past.
    const september = {
      ...DINNER,
      recurrence: { freq: 'weekly' as const, untilDate: '2026-09-30' },
    };
    expect(refined({ date: '2026-10-20' }, 'move it to Oct 20', september)).toMatchObject({
      date: '2026-10-20',
      recurrence: { freq: 'weekly', untilDate: '2026-09-30' },
    });
  });

  it('gives a repeat the end the words name, and only then', () => {
    const weekly = { ...DINNER, recurrence: { freq: 'weekly' as const } };
    expect(
      refined({ recurrence: { freq: 'weekly', untilDate: '2026-03-31' } }, 'until March', weekly)
        .recurrence,
    ).toEqual({ freq: 'weekly', untilDate: '2027-03-31' });
    // An until that is a time, and an end the model added to a change
    // about something else, leave the repeat as it was.
    expect(
      refined({ recurrence: { freq: 'weekly', untilDate: '2026-09-30' } }, 'until 5pm', weekly)
        .recurrence,
    ).toEqual({ freq: 'weekly' });
    expect(
      refined({ recurrence: { freq: 'weekly', untilDate: '2026-09-30' } }, 'at 8', weekly)
        .recurrence,
    ).toEqual({ freq: 'weekly' });
    // A draft that does not repeat gets no repeat from an end alone.
    expect(
      refined({ recurrence: { freq: 'weekly', untilDate: '2026-09-30' } }, 'until Friday')
        .recurrence,
    ).toBeUndefined();
    // Review: "ends at 9" is a time, not an end.
    expect(
      refined({ recurrence: { freq: 'weekly', untilDate: '2026-09-04' } }, 'ends at 9', weekly)
        .recurrence,
    ).toEqual({ freq: 'weekly' });
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

  it('keeps a spanning draft its whole length when only the start is restated', () => {
    const night = { ...DINNER, endDate: '2026-08-29', endTime: '01:00', startTime: '23:00' };
    expect(refined({ startTime: '22:00' }, 'start at 10pm', night)).toMatchObject({
      date: '2026-08-28',
      endDate: '2026-08-29',
      endTime: '00:00',
      startTime: '22:00',
    });
    // A stated range is the whole new time, on one day.
    expect(refined({}, 'from 8 to 9pm', night)).toMatchObject({
      endTime: '21:00',
      startTime: '20:00',
    });
    expect(refined({}, 'from 8 to 9pm', night).endDate).toBeUndefined();
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

  it('asks who is invited only for a draft that takes guests', async () => {
    const model = fakeModel(DINNER);
    await parseRefine(model, { draft: DINNER, utterance: 'invite Tom', ...CONTEXT });
    expect(model.prompts).toHaveLength(2);
    await parseRefine(model, { draft: DINNER, guests: false, utterance: 'invite Tom', ...CONTEXT });
    expect(model.prompts).toHaveLength(3);
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

describe('parseRefine reads the note and the notifications beside the change', () => {
  it('needs no model for words about nothing else, and leaves the draft as it is', async () => {
    const model = fakeModel({ title: 'unused' }, { status: 'unavailable' });
    for (const [utterance, expected] of [
      ['notify me 15 minutes before', { reminders: { add: [15], clear: false, remove: [] } }],
      ['and an hour before as well', { reminders: { add: [60], clear: false, remove: [] } }],
      [
        'add a note: bring the insurance card',
        { notes: { kind: 'add', text: 'bring the insurance card' } },
      ],
      ['no notifications', { reminders: { add: [], clear: true, remove: [] } }],
    ] as const) {
      expect(await parseRefine(model, { draft: DINNER, utterance, ...CONTEXT }), utterance).toEqual(
        {
          kind: 'parsed',
          prefill: DINNER,
          ...expected,
        },
      );
    }
    expect(model.prompts).toHaveLength(0);
  });

  it('shows the model only the change, with the note and notifications beside the answer', async () => {
    const model = fakeModel({ ...DINNER, date: '2026-08-27' });
    const result = await parseRefine(model, {
      draft: DINNER,
      utterance: 'Thursday instead, remind me 10 minutes before and note that we meet at the bar',
      ...CONTEXT,
    });
    expect(result).toEqual({
      kind: 'parsed',
      notes: { kind: 'add', text: 'we meet at the bar' },
      prefill: { ...DINNER, date: '2026-08-27' },
      reminders: { add: [10], clear: false, remove: [] },
    });
    expect(model.prompts[0]).toContain('Change: Thursday instead');
    expect(model.prompts[0]).not.toContain('remind me');
  });
});
