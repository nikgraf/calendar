import { describe, expect, it } from 'vite-plus/test';
import type { LanguageModel, ModelStatus } from './model.ts';
import { ModelUnavailableError } from './model.ts';
import { parseQuickAdd } from './parseQuickAdd.ts';
import type { QuickAddParse } from './quickAdd.ts';

// 2026-08-22 is a Saturday.
const CONTEXT = { referenceDate: '2026-08-22', timeZone: 'Europe/Vienna' };

/** A model that replays a fixed extraction, recording the prompt it saw. */
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

/**
 * The answer is held against the phrase, so every fake extraction here
 * comes with the words it could have come from.
 */
const prefillOf = async (parse: QuickAddParse, phrase: string, fallbackDate?: string) => {
  const result = await parseQuickAdd(fakeModel(parse), {
    ...(fallbackDate === undefined ? {} : { fallbackDate }),
    phrase,
    ...CONTEXT,
  });
  if (result.kind !== 'parsed') {
    throw new Error(`expected a parse, got: ${JSON.stringify(result)}`);
  }
  return result.prefill;
};

// "every Monday until March", said in August: the model answers with
// this year's March, which is already past.
const untilOf = async (untilDate: string) =>
  (
    await prefillOf(
      { recurrence: { freq: 'weekly', untilDate }, startTime: '09:00', title: 'Standup' },
      'Standup weekly at 9',
    )
  ).recurrence?.untilDate;

describe('parseQuickAdd', () => {
  it('fills the editor from a typical English phrase', async () => {
    const prefill = await prefillOf(
      {
        date: '2026-08-25',
        endTime: '14:00',
        location: 'Figlmüller',
        startTime: '13:00',
        title: 'Lunch with Sarah',
      },
      'lunch with Sarah tue 1pm at Figlmüller',
    );
    expect(prefill).toEqual({
      date: '2026-08-25',
      endTime: '14:00',
      isAllDay: false,
      location: 'Figlmüller',
      startTime: '13:00',
      title: 'Lunch with Sarah',
    });
  });

  it('keeps a German title and time as extracted', async () => {
    // "nächsten Dienstag um halb drei" — the model resolves the date; the
    // normalizer must not anglicise or drop the title, and 14:30 is a
    // reading of "halb drei".
    const prefill = await prefillOf(
      { date: '2026-08-25', startTime: '14:30', title: 'Zahnarzt' },
      'Zahnarzt nächsten Dienstag um halb drei',
    );
    expect(prefill.title).toBe('Zahnarzt');
    expect(prefill.date).toBe('2026-08-25');
    expect(prefill.startTime).toBe('14:30');
    expect(prefill.endTime).toBe('15:30');
  });

  it('gives a bare start time a one-hour default', async () => {
    const prefill = await prefillOf({ startTime: '09:00', title: 'Standup' }, 'Standup at 9');
    expect(prefill).toMatchObject({ endTime: '10:00', isAllDay: false, startTime: '09:00' });
  });

  it('takes the end from the phrase, never from the model', async () => {
    // A backwards model end is ignored like any other: the phrase states no end.
    expect(
      (await prefillOf({ endTime: '08:00', startTime: '09:00', title: 'x' }, 'x at 9')).endTime,
    ).toBe('10:00');
    // Observed: a two-hour end invented for a bare start.
    expect(
      (await prefillOf({ endTime: '20:00', startTime: '18:00', title: 'x' }, 'x at 6pm')).endTime,
    ).toBe('19:00');
    expect(
      (await prefillOf({ endTime: '08:00', startTime: '09:00', title: 'x' }, 'x 9-9:30')).endTime,
    ).toBe('09:30');
    expect(
      await prefillOf({ startTime: '14:00', title: 'Workshop' }, 'Workshop 2-4pm tomorrow'),
    ).toMatchObject({ date: '2026-08-23', endTime: '16:00', startTime: '14:00' });
  });

  it('clamps rather than spilling past midnight', async () => {
    expect((await prefillOf({ startTime: '23:30', title: 'Late' }, 'Late at 23:30')).endTime).toBe(
      '23:59',
    );
  });

  it('falls back to all-day when no time was stated, whatever the model invented', async () => {
    // Observed on device: 13:00 for a phrase without a time, and 00:00 with
    // isAllDay false for another — either became a timed event.
    const prefill = await prefillOf(
      { date: '2026-09-01', endTime: '14:00', startTime: '13:00', title: 'Conference' },
      'Conference Sep 1',
    );
    expect(prefill).toMatchObject({ date: '2026-09-01', isAllDay: true, startTime: '00:00' });
    expect(
      await prefillOf(
        {
          date: '2026-08-23',
          endTime: '00:00',
          isAllDay: false,
          startTime: '00:00',
          title: 'Call',
        },
        'Call with Anna tomorrow',
      ),
    ).toMatchObject({ date: '2026-08-23', isAllDay: true });
  });

  it('defaults the date to today when the phrase gave none', async () => {
    expect((await prefillOf({ startTime: '09:00', title: 'Standup' }, 'Standup at 9')).date).toBe(
      '2026-08-22',
    );
  });

  it('carries a recurrence through as editor fields', async () => {
    const prefill = await prefillOf(
      { recurrence: { count: 5, freq: 'weekly', interval: 2 }, startTime: '10:00', title: 'Retro' },
      'Retro every two weeks at 10',
    );
    // The editor's own fields, so the user sees and can adjust them before
    // the existing save path builds the RRULE.
    expect(prefill.recurrence).toEqual({ count: 5, freq: 'weekly', interval: 2 });
  });

  it('ignores junk the model invented instead of trusting the schema', async () => {
    // Schema-shaped but semantically wrong: an impossible time, a bad date,
    // and a recurrence end that isn't a date.
    const prefill = await prefillOf(
      {
        date: 'next tuesday',
        recurrence: { freq: 'daily', untilDate: 'december' },
        startTime: '25:70',
        title: 'Thing',
      },
      'Thing',
    );
    expect(prefill.date).toBe('2026-08-22');
    expect(prefill.isAllDay).toBe(true);
    expect(prefill.recurrence).toEqual({ freq: 'daily' });
  });

  it('drops placeholder strings the model invents', async () => {
    // Observed on device: "unknown" written into a location the phrase
    // never mentioned.
    const prefill = await prefillOf(
      { location: 'unknown', startTime: '09:00', title: 'Standup' },
      'Standup at 9',
    );
    expect(prefill.location).toBeUndefined();
    expect(
      await parseQuickAdd(fakeModel({ location: 'N/A', title: 'none' }), {
        phrase: 'x',
        ...CONTEXT,
      }),
    ).toMatchObject({ kind: 'rejected' });
  });

  it('drops a location that only repeats the title', async () => {
    // Observed on device: "Dentist" as the location of "Dentist Thursday",
    // "offsite" for "Team offsite Oct 20".
    expect(
      (await prefillOf({ location: 'Dentist', title: 'Dentist' }, 'Dentist Thursday')).location,
    ).toBeUndefined();
    expect(
      (
        await prefillOf(
          { location: 'offsite', title: 'Team offsite Oct 20' },
          'Team offsite Oct 20',
        )
      ).location,
    ).toBeUndefined();
    expect(
      (await prefillOf({ location: 'Figlmüller', title: 'Lunch' }, 'Lunch at Figlmüller')).location,
    ).toBe('Figlmüller');
  });

  it('drops a repeat that only happens once', async () => {
    // Also observed: "next Tuesday" came back as a weekly repeat, count 1.
    const prefill = await prefillOf(
      { recurrence: { count: 1, freq: 'weekly' }, startTime: '13:00', title: 'Lunch' },
      'Lunch next Tuesday at 1',
    );
    expect(prefill.recurrence).toBeUndefined();
    expect(prefill.date).toBe('2026-08-25');
  });

  it('reads a repeat end before the first day as next year', async () => {
    expect(await untilOf('2026-03-31')).toBe('2027-03-31');
    expect(await untilOf('2026-12-31')).toBe('2026-12-31');
    expect(await untilOf('2026-08-22')).toBe('2026-08-22');
    // More than a year back is a misread, not next year's.
    expect(await untilOf('2024-03-31')).toBeUndefined();
  });

  it('rejects a date-shaped string that is not a real date', async () => {
    // '2026-02-30' passes a regex but is not a day; it used to reach Google
    // as UNTIL=20260230T235959Z and come back a 400.
    const prefill = await prefillOf(
      {
        recurrence: { freq: 'weekly', untilDate: '2026-02-30' },
        startTime: '09:00',
        title: 'Standup',
      },
      'Standup weekly at 9',
    );
    expect(prefill.recurrence).toEqual({ freq: 'weekly' });

    // An impossible event date falls back to the visible day rather than
    // dead-ending: the editor shows the date, so the user can correct it.
    const result = await parseQuickAdd(fakeModel({ date: '2026-02-30', title: 'x' }), {
      fallbackDate: '2026-09-05',
      phrase: 'x',
      ...CONTEXT,
    });
    expect(result).toMatchObject({ prefill: { date: '2026-09-05' } });
  });

  it('drops a frequency the rule builder does not understand', async () => {
    // Apple's guided decoding enforces the enum, but the seam exists for
    // providers that will not.
    const prefill = await prefillOf(
      { recurrence: { freq: 'fortnightly' as never }, startTime: '09:00', title: 'Standup' },
      'Standup at 9',
    );
    expect(prefill.recurrence).toBeUndefined();
  });

  it('explains the midnight limit instead of blaming the phrase', async () => {
    const result = await parseQuickAdd(fakeModel({ startTime: '23:59', title: 'Call mom' }), {
      phrase: 'call mom at 11:59pm',
      ...CONTEXT,
    });
    expect(result).toEqual({
      kind: 'rejected',
      reason: 'That would end after midnight — pick an earlier time.',
    });
  });

  it('falls back to the day being viewed, not today', async () => {
    // Swiped to September, typed "lunch at 1pm": the event belongs on the
    // visible day, while "tomorrow" still anchors on today.
    const result = await parseQuickAdd(fakeModel({ startTime: '13:00', title: 'Lunch' }), {
      fallbackDate: '2026-09-05',
      phrase: 'lunch at 1pm',
      ...CONTEXT,
    });
    expect(result).toMatchObject({ prefill: { date: '2026-09-05' } });
    expect(
      await parseQuickAdd(fakeModel({ startTime: '13:00', title: 'Lunch' }), {
        fallbackDate: '2026-09-05',
        phrase: 'lunch tomorrow at 1pm',
        ...CONTEXT,
      }),
    ).toMatchObject({ prefill: { date: '2026-08-23' } });
  });

  it('ignores an unusable fallback day', async () => {
    const result = await parseQuickAdd(fakeModel({ startTime: '13:00', title: 'Lunch' }), {
      fallbackDate: 'not-a-date',
      phrase: 'lunch at 1pm',
      ...CONTEXT,
    });
    expect(result).toMatchObject({ prefill: { date: '2026-08-22' } });
  });

  it('rejects an empty phrase without calling the model', async () => {
    const model = fakeModel({ title: 'unused' });
    const result = await parseQuickAdd(model, { phrase: '   ', ...CONTEXT });
    expect(result).toEqual({ kind: 'rejected', reason: 'Type what you want to schedule.' });
    expect(model.prompts).toHaveLength(0);
  });

  it('rejects a titleless extraction', async () => {
    const result = await parseQuickAdd(fakeModel({ startTime: '09:00' }), {
      phrase: 'asdfgh',
      ...CONTEXT,
    });
    expect(result).toEqual({ kind: 'rejected', reason: 'No event title was recognised.' });
  });

  it('survives a model that throws', async () => {
    const result = await parseQuickAdd(
      fakeModel(() => {
        throw new Error('inference failed');
      }),
      { phrase: 'lunch tomorrow', ...CONTEXT },
    );
    expect(result.kind).toBe('rejected');
  });

  it('signals unavailability distinctly, so callers can hide the feature', async () => {
    await expect(
      parseQuickAdd(fakeModel({ title: 'x' }, { status: 'unavailable' }), {
        phrase: 'lunch tomorrow',
        ...CONTEXT,
      }),
    ).rejects.toThrow(ModelUnavailableError);
  });

  it('grounds the prompt with the reference date and zone', async () => {
    const model = fakeModel({ title: 'x' });
    await parseQuickAdd(model, { phrase: 'lunch tomorrow', ...CONTEXT });
    const [prompt] = model.prompts;
    expect(prompt).toContain('2026-08-22');
    expect(prompt).toContain('Europe/Vienna');
    expect(prompt).toContain('lunch tomorrow');
  });

  it('hands the model a dated weekday list rather than asking it to count', async () => {
    const model = fakeModel({ title: 'x' });
    await parseQuickAdd(model, { phrase: 'lunch next tuesday', ...CONTEXT });
    const [prompt] = model.prompts;
    // 2026-08-22 is a Saturday, so the next Tuesday is the 25th.
    expect(prompt).toContain('Sat 2026-08-22 (today)');
    expect(prompt).toContain('Tue 2026-08-25');
  });
});

describe('parseQuickAdd holds the answer against the phrase', () => {
  it('puts a meal at its usual time, on the weekday named', async () => {
    // The reported bug: "Dinner with Teo" came back at 13:00, and "next
    // Friday" on a Thursday.
    const prefill = await prefillOf(
      { date: '2026-08-27', endTime: '13:00', startTime: '13:00', title: 'Dinner with Teo' },
      'Dinner with Teo next Friday',
    );
    expect(prefill).toEqual({
      date: '2026-08-28',
      endTime: '20:00',
      isAllDay: false,
      startTime: '19:00',
      title: 'Dinner with Teo',
    });
  });

  it('reads "at 8" for dinner as 20:00 when the model said 18:00', async () => {
    const prefill = await prefillOf(
      { date: '2026-08-28', endTime: '20:00', startTime: '18:00', title: 'Dinner with Teo' },
      'Dinner with Teo at 8 next Friday',
    );
    expect(prefill).toMatchObject({ endTime: '21:00', startTime: '20:00' });
  });

  it('keeps a model time the stated hour allows', async () => {
    expect(
      (await prefillOf({ startTime: '21:00', title: 'Drinks' }, 'Drinks at 9')).startTime,
    ).toBe('21:00');
    expect(
      (await prefillOf({ startTime: '08:00', title: 'Breakfast' }, 'Breakfast at 8')).startTime,
    ).toBe('08:00');
  });

  it('fills a time the model left out but the phrase states', async () => {
    // The fixture model answers with the title alone.
    expect(await prefillOf({ title: 'Lunch at 1' }, 'Lunch at 1')).toMatchObject({
      endTime: '14:00',
      isAllDay: false,
      startTime: '13:00',
    });
  });

  it('lands a named weekday on that weekday', async () => {
    // Observed: "Thursday" came back as a Tuesday.
    expect(
      (await prefillOf({ date: '2026-08-25', title: 'Dentist' }, 'Dentist Thursday')).date,
    ).toBe('2026-08-27');
    expect(
      (await prefillOf({ date: '2026-08-22', title: 'Dentist' }, 'Dentist next Saturday')).date,
    ).toBe('2026-08-29');
    // Said on a Saturday, viewing September: the Tuesday is next week's, not the viewed day.
    expect(
      (await prefillOf({ title: 'Lunch' }, 'Lunch next Tuesday at 1pm', '2026-09-05')).date,
    ).toBe('2026-08-25');
  });

  it('reads today itself, over the viewed day', async () => {
    expect((await prefillOf({ title: 'Call' }, 'Call today', '2026-09-05')).date).toBe(
      '2026-08-22',
    );
  });

  it('leaves a date it cannot read to the model', async () => {
    expect((await prefillOf({ date: '2026-10-20', title: 'Offsite' }, 'Offsite Oct 20')).date).toBe(
      '2026-10-20',
    );
  });
});

describe('parseQuickAdd for tasks', () => {
  it('returns a task prefill with its day and the time it named', async () => {
    const result = await parseQuickAdd(
      fakeModel({ date: '2026-08-25', startTime: '09:30', title: 'Call the bank' }),
      { phrase: 'remind me to call the bank tue 9:30', ...CONTEXT },
    );
    expect(result).toEqual({
      kind: 'task',
      prefill: { date: '2026-08-25', time: '09:30', title: 'Call the bank' },
    });
  });

  it('leaves the cue out of the title when the model kept it', async () => {
    // Observed: "remind me to call the bank" came back as the whole title.
    const result = await parseQuickAdd(
      fakeModel({ date: '2026-08-25', startTime: '09:30', title: 'remind me to call the bank' }),
      { phrase: 'remind me to call the bank tue 9:30', ...CONTEXT },
    );
    expect(result).toMatchObject({ kind: 'task', prefill: { title: 'call the bank' } });
    // A title that is nothing but the cue stays as it is rather than going blank.
    expect(
      await parseQuickAdd(fakeModel({ title: 'Reminder' }), { phrase: 'reminder', ...CONTEXT }),
    ).toMatchObject({ kind: 'task', prefill: { title: 'Reminder' } });
  });

  it('gives an undated to-do the fallback day and no time', async () => {
    const result = await parseQuickAdd(fakeModel({ title: 'Buy milk' }), {
      fallbackDate: '2026-08-30',
      phrase: 'todo buy milk',
      ...CONTEXT,
    });
    expect(result).toEqual({ kind: 'task', prefill: { date: '2026-08-30', title: 'Buy milk' } });
  });

  it("is a to-do on the phrase's cue, not on the model's say-so", async () => {
    // Observed: the model called "Lunch with Sarah tomorrow at 1" a task.
    // The kind is no longer asked of it; an appointment stays an event.
    const result = await parseQuickAdd(
      fakeModel({ date: '2026-08-23', startTime: '13:00', title: 'Lunch with Sarah' }),
      { phrase: 'Lunch with Sarah tomorrow at 1', ...CONTEXT },
    );
    expect(result.kind).toBe('parsed');
    const german = await parseQuickAdd(fakeModel({ title: 'Bank anrufen' }), {
      phrase: 'Ich muss die Bank anrufen',
      ...CONTEXT,
    });
    expect(german.kind).toBe('task');
  });

  it('puts a to-do that names a part of the day at its default time', async () => {
    const result = await parseQuickAdd(fakeModel({ title: 'Call mom' }), {
      phrase: 'remind me to call mom this evening',
      ...CONTEXT,
    });
    expect(result).toEqual({
      kind: 'task',
      prefill: { date: '2026-08-22', time: '18:00', title: 'Call mom' },
    });
  });

  it('still needs a title', async () => {
    const result = await parseQuickAdd(fakeModel({ title: '   ' }), {
      phrase: 'todo',
      ...CONTEXT,
    });
    expect(result.kind).toBe('rejected');
  });
});
