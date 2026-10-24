import { describe, expect, it } from 'vite-plus/test';
import type { LanguageModel, ModelStatus } from './model.ts';
import type { PeopleParse } from './invitees.ts';
import { ModelUnavailableError } from './model.ts';
import { normalizeQuickAdd } from './normalizeQuickAdd.ts';
import { parseQuickAdd } from './parseQuickAdd.ts';
import type { QuickAddParse } from './quickAdd.ts';

// 2026-08-22 is a Saturday.
const CONTEXT = { referenceDate: '2026-08-22', timeZone: 'Europe/Vienna' };

/** A model that replays a fixed extraction, recording the prompt it saw (the people question too). */
const fakeModel = (
  parse: (QuickAddParse & PeopleParse) | (() => never),
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

  it('keeps a place only as the phrase says it', async () => {
    // Observed on device: "Dentist" as the location of "Dentist Thursday",
    // "Board review" of "Board review Thursday 2pm" — title words copied over.
    expect(
      (await prefillOf({ location: 'Dentist', title: 'Dentist' }, 'Dentist Thursday')).location,
    ).toBeUndefined();
    expect(
      (
        await prefillOf(
          { location: 'Dentist', title: 'Dentist tomorrow at 9' },
          'Dentist tomorrow at 9',
        )
      ).location,
    ).toBeUndefined();
    expect(
      (await prefillOf({ location: 'Figlmüller', title: 'Lunch' }, 'Lunch at Figlmüller')).location,
    ).toBe('Figlmüller');
    // Part of the title too, but after a place cue: a place.
    expect(
      (
        await prefillOf(
          { location: 'the office', title: 'Meeting at the office' },
          'Meeting at the office tomorrow',
        )
      ).location,
    ).toBe('the office');
    expect(
      (await prefillOf({ location: 'Café Central', title: 'Kaffee' }, 'Kaffee im Café Central'))
        .location,
    ).toBe('Café Central');
    expect(
      (await prefillOf({ location: 'Figlmüller', title: 'Lunch' }, 'Lunch at 1 at Figlmüller'))
        .location,
    ).toBe('Figlmüller');
    // Not in the phrase at all: made up ("Bob's house" was observed), or echoed.
    expect(
      (await prefillOf({ location: "Bob's house", title: 'Dinner' }, 'Dinner Friday 7pm')).location,
    ).toBeUndefined();
    // The title's start with no cue reads as title, not place — the user
    // adds "New York" by hand; "Dentist" was the far more common case.
    expect(
      (await prefillOf({ location: 'New York', title: 'New York trip' }, 'New York trip in May'))
        .location,
    ).toBeUndefined();
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

  it('shows the model no example title to copy', async () => {
    // An example's title came back for phrases of its shape.
    const model = fakeModel({ title: 'x' });
    await parseQuickAdd(model, { phrase: 'lunch with tom tomorrow', ...CONTEXT });
    const [prompt] = model.prompts;
    expect(prompt).not.toMatch(/has the title|Sarah|Call the bank/);
  });
});

describe('parseQuickAdd titles', () => {
  it('never takes a name the phrase did not say', async () => {
    // The reported bug, on device: "lunch with tom tomorrow" came back as
    // "Lunch with Sarah", the prompt's example.
    const prefill = await prefillOf(
      { date: '2026-08-23', endTime: '13:00', startTime: '12:00', title: 'Lunch with Sarah' },
      'lunch with tom tomorrow ',
    );
    expect(prefill).toEqual({
      assumedTime: true,
      date: '2026-08-23',
      endTime: '13:30',
      isAllDay: false,
      startTime: '12:30',
      title: 'Lunch with tom',
    });
    expect(
      (await prefillOf({ location: 'tom', title: 'tomorrow' }, 'dinner with tom tomorrow')).title,
    ).toBe('Dinner with tom');
  });

  it('takes the words about when off the title', async () => {
    expect(
      (
        await prefillOf(
          { startTime: '09:00', title: 'Team standup every monday at 9' },
          'Team standup every monday at 9',
        )
      ).title,
    ).toBe('Team standup');
    expect(
      await prefillOf(
        { location: 'Mercato', startTime: '12:30', title: 'Lunch with Sam tomorrow at 12:30' },
        'Lunch with Sam tomorrow at 12:30 at Mercato',
      ),
    ).toMatchObject({ location: 'Mercato', title: 'Lunch with Sam' });
  });

  it('keeps the place out of the title and in its field', async () => {
    // Review: a model title with "with" for "w/" fell back to the phrase,
    // place and all.
    expect(
      await prefillOf(
        { location: 'Figlmüller', startTime: '13:00', title: 'Lunch with Tom' },
        'Lunch w/ Tom at Figlmüller tomorrow at 1',
      ),
    ).toMatchObject({ location: 'Figlmüller', title: 'Lunch with Tom' });
    // Observed: the place left in a title the model kept a day in.
    expect(
      await prefillOf(
        { location: 'Loos Bar', startTime: '19:00', title: 'drinks with jo at Loos Bar friday' },
        'drinks with jo at Loos Bar friday 7pm',
      ),
    ).toMatchObject({ location: 'Loos Bar', title: 'Drinks with jo' });
    // A translated title gives way to the phrase, and a place no word
    // leads into is part of it.
    const translated = await prefillOf(
      { location: 'Figlmüller', title: 'Lunch' },
      'Mittagessen Figlmüller morgen',
    );
    expect(translated.title).toBe('Mittagessen Figlmüller');
    expect(translated.location).toBeUndefined();
    // Review: a place after "to" stays in the title, and a title is never
    // its own place.
    const trip = await prefillOf(
      { location: 'Vienna', title: 'Business trip' },
      'trip to Vienna friday',
    );
    expect(trip.title).toBe('Trip to Vienna');
    expect(trip.location).toBeUndefined();
    const yoga = await prefillOf(
      { location: 'Yoga', startTime: '07:00', title: 'Morning workout' },
      'Yoga tomorrow 7am',
    );
    expect(yoga.title).toBe('Yoga');
    expect(yoga.location).toBeUndefined();
  });

  it('takes no when and no company for the place', async () => {
    // Observed on the real model: "tomorrow" and "tom" as the location.
    expect(
      (
        await prefillOf(
          { location: 'tomorrow', title: 'Lunch with Tom' },
          'Tomorrow - lunch with Tom',
        )
      ).location,
    ).toBeUndefined();
    expect(
      (await prefillOf({ location: 'tom', title: 'tomorrow lunch' }, 'tomorrow lunch with tom'))
        .location,
    ).toBeUndefined();
    // A name said with "with" can still be the place where a cue says so.
    expect(
      (await prefillOf({ location: 'Anna', title: 'Coffee' }, 'coffee with Anna at Anna')).location,
    ).toBe('Anna');
  });

  it('capitalizes a first word typed in lower case, and nothing else', async () => {
    expect((await prefillOf({ title: 'coffee with max' }, 'coffee with max')).title).toBe(
      'Coffee with max',
    );
    expect((await prefillOf({ title: 'iPhone repair' }, 'iPhone repair friday')).title).toBe(
      'iPhone repair',
    );
    expect((await prefillOf({ title: 'Zahnarzt' }, 'Zahnarzt morgen')).title).toBe('Zahnarzt');
  });

  it('keeps an invitation out of a title made of the phrase', async () => {
    const result = await parseQuickAdd(
      fakeModel({ people: ['Tom'], startTime: '13:00', title: 'Lunch with Sarah and Tom' }),
      { phrase: 'lunch with sam tomorrow at 1, invite Tom', ...CONTEXT },
    );
    expect(result).toMatchObject({
      invite: ['Tom'],
      kind: 'parsed',
      prefill: { title: 'Lunch with sam' },
    });
  });
});

describe('parseQuickAdd holds the answer against the phrase', () => {
  it('puts a meal at its usual time, on the weekday named, and says the time is assumed', async () => {
    // The reported bug: "Dinner with Teo" came back at 13:00, and "next
    // Friday" on a Thursday.
    const prefill = await prefillOf(
      { date: '2026-08-27', endTime: '13:00', startTime: '13:00', title: 'Dinner with Teo' },
      'Dinner with Teo next Friday',
    );
    expect(prefill).toEqual({
      assumedTime: true,
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
    // Review: a past weekday stays in the past; an offset's anchor is not the date.
    expect(
      (
        await prefillOf(
          { date: '2026-08-21', startTime: '09:00', title: 'Dentist' },
          'Dentist last Friday at 9am',
        )
      ).date,
    ).toBe('2026-08-21');
    expect(
      (await prefillOf({ date: '2026-09-05', title: 'Call' }, 'Call two weeks from today')).date,
    ).toBe('2026-09-05');
  });

  it('leaves a meal used as a boundary to the model', async () => {
    // Review: "before lunch" was read as lunch itself.
    expect(
      await prefillOf(
        { date: '2026-08-24', startTime: '11:00', title: 'Call' },
        'Call before lunch Monday',
      ),
    ).toMatchObject({ date: '2026-08-24', endTime: '12:00', startTime: '11:00' });
    expect(await prefillOf({ title: 'Call' }, 'Call after dinner')).toMatchObject({
      isAllDay: true,
    });
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
    expect(result).toMatchObject({ kind: 'task', prefill: { title: 'Call the bank' } });
    // A title that is nothing but the cue stays as it is rather than going blank.
    expect(
      await parseQuickAdd(fakeModel({ title: 'Reminder' }), { phrase: 'reminder', ...CONTEXT }),
    ).toMatchObject({ kind: 'task', prefill: { title: 'Reminder' } });
  });

  it('leaves the cue out of a title made of the phrase, a day inside it too', async () => {
    const result = await parseQuickAdd(fakeModel({ title: 'Phone the bank' }), {
      phrase: 'remind me tomorrow to call the bank',
      ...CONTEXT,
    });
    expect(result).toMatchObject({
      kind: 'task',
      prefill: { date: '2026-08-23', title: 'Call the bank' },
    });
  });

  it('reads a cue only with when-words before its "to"', async () => {
    // Review: "to Paris" read as the cue's "to".
    const result = await parseQuickAdd(fakeModel({ title: 'remind me about the trip to Paris' }), {
      phrase: 'remind me about the trip to Paris',
      ...CONTEXT,
    });
    expect(result).toMatchObject({
      kind: 'task',
      prefill: { title: 'Remind me about the trip to Paris' },
    });
  });

  it("keeps a to-do's place in its title, having no place field", async () => {
    // Codex: the pickup place vanished.
    const result = await parseQuickAdd(
      fakeModel({ location: 'reception', title: 'Pick up the keys at reception' }),
      { phrase: 'remind me to pick up the keys at reception tomorrow', ...CONTEXT },
    );
    expect(result).toMatchObject({
      kind: 'task',
      prefill: { title: 'Pick up the keys at reception' },
    });
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

describe('parseQuickAdd invitees', () => {
  it('invites the people the phrase says to, the invitation out of the title', async () => {
    const result = await parseQuickAdd(
      fakeModel({
        date: '2026-08-25',
        people: ['Sarah', 'Tom', 'Anna'],
        startTime: '13:00',
        title: 'Lunch with Sarah, invite Tom and Anna',
      }),
      { phrase: 'Lunch with Sarah Tuesday at 1, invite Tom and Anna', ...CONTEXT },
    );
    expect(result).toMatchObject({
      invite: ['Tom', 'Anna'],
      kind: 'parsed',
      prefill: { startTime: '13:00', title: 'Lunch with Sarah' },
    });
  });

  it('invites no one without a cue, and a to-do never', async () => {
    const lunch = await parseQuickAdd(fakeModel({ people: ['Sarah'], title: 'Lunch with Sarah' }), {
      phrase: 'Lunch with Sarah on Tuesday',
      ...CONTEXT,
    });
    expect(lunch.kind).toBe('parsed');
    expect(lunch).not.toHaveProperty('invite');
    const todo = await parseQuickAdd(fakeModel({ people: ['Tom'], title: 'Invite Tom' }), {
      phrase: 'remind me to invite Tom',
      ...CONTEXT,
    });
    expect(todo).toEqual({ kind: 'task', prefill: { date: '2026-08-22', title: 'Invite Tom' } });
  });

  it('asks who is invited only when the words hold a cue', async () => {
    const model = fakeModel({ people: ['Sarah'], startTime: '13:00', title: 'Lunch with Sarah' });
    await parseQuickAdd(model, { phrase: 'Lunch with Sarah at 1', ...CONTEXT });
    expect(model.prompts).toHaveLength(1);
    // Taking a guest off says nothing about a new event.
    await parseQuickAdd(model, { phrase: 'Coffee without sugar at 1', ...CONTEXT });
    expect(model.prompts).toHaveLength(2);
    await parseQuickAdd(model, { phrase: 'Lunch at 1, invite Sarah', ...CONTEXT });
    expect(model.prompts).toHaveLength(4);
    expect(model.prompts[2]).toContain('Sentence: Lunch at 1, invite Sarah');
  });

  it('keeps a capture’s place as it is, even the title over again', () => {
    // Review: a captured reservation titled and placed "Figlmüller" lost its place.
    const result = normalizeQuickAdd(
      { location: 'Figlmüller', startTime: '19:00', title: 'Figlmüller' },
      CONTEXT,
    );
    expect(result).toMatchObject({ kind: 'parsed', prefill: { location: 'Figlmüller' } });
  });

  it('leaves a capture (no phrase) without invitees', () => {
    const result = normalizeQuickAdd(
      { startTime: '10:00', title: 'Review, invite Tom' },
      { ...CONTEXT, people: ['Tom'] },
    );
    expect(result).toMatchObject({ kind: 'parsed', prefill: { title: 'Review, invite Tom' } });
    expect(result).not.toHaveProperty('invite');
  });
});
