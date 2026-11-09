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
      'Standup weekly at 9 until March',
    )
  ).recurrence?.untilDate;

const WEEKDAYS = [
  { weekday: 'MO' as const },
  { weekday: 'TU' as const },
  { weekday: 'WE' as const },
  { weekday: 'TH' as const },
  { weekday: 'FR' as const },
];

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

  it('carries a recurrence through as editor fields, as the phrase states it', async () => {
    // The editor's own fields, so the user sees and can adjust them before
    // the existing save path builds the RRULE. The gap is the phrase's;
    // a count the phrase never said is not.
    const retro = {
      recurrence: { count: 5, freq: 'weekly', interval: 2 },
      startTime: '10:00',
      title: 'Retro',
    } as const;
    expect((await prefillOf(retro, 'Retro every two weeks at 10')).recurrence).toEqual({
      freq: 'weekly',
      interval: 2,
    });
    expect((await prefillOf(retro, 'Retro every two weeks at 10, 5 times')).recurrence).toEqual({
      count: 5,
      freq: 'weekly',
      interval: 2,
    });
  });

  it('keeps a repeat the phrase names, whatever the model made of it', async () => {
    // Observed on device (the bench): a genuine repeat comes back as one
    // week — count 1, and an end a week after the first day. The repeat
    // is the phrase's; the count and the end are not.
    const standup = {
      date: '2026-08-24',
      recurrence: { count: 1, freq: 'weekly', interval: 1, untilDate: '2026-08-31' },
      startTime: '09:00',
      title: 'Team standup',
    } as const;
    expect(await prefillOf(standup, 'Team standup every monday at 9')).toMatchObject({
      date: '2026-08-24',
      recurrence: { freq: 'weekly' },
    });
    expect(
      await prefillOf(
        { ...standup, date: '2026-08-25', startTime: '18:00', title: 'Fußball' },
        'Jeden Dienstag um 18 Uhr Fußball',
      ),
    ).toMatchObject({ date: '2026-08-25', recurrence: { freq: 'weekly' } });
    // A real end stays, read as the coming March.
    expect(
      await prefillOf(
        {
          date: '2026-08-25',
          recurrence: { count: 1, freq: 'weekly', interval: 1, untilDate: '2026-03-01' },
          startTime: '17:00',
          title: 'Piano lesson',
        },
        'Piano lesson every Tuesday at 5pm until March',
      ),
    ).toMatchObject({ recurrence: { freq: 'weekly', untilDate: '2027-03-01' } });
    // "every week" said of a draft: the same answer, the same reading.
    expect(
      (await prefillOf({ ...standup, title: 'Standup' }, 'Standup every week at 9')).recurrence,
    ).toEqual({ freq: 'weekly' });
  });

  it('reads the frequency, the gap and the days from the phrase', async () => {
    // Observed: "every weekday" as five times, "every two weeks" as a gap
    // of fourteen, "every month" as weekly.
    expect(
      await prefillOf(
        {
          date: '2026-08-24',
          recurrence: { count: 5, freq: 'weekly', interval: 1, untilDate: '2026-08-30' },
          startTime: '09:30',
          title: 'Standup',
        },
        'Standup every weekday at 9:30',
      ),
    ).toMatchObject({ date: '2026-08-24', recurrence: { byDay: WEEKDAYS, freq: 'weekly' } });
    expect(
      await prefillOf(
        {
          date: '2026-08-27',
          recurrence: { count: 2, freq: 'weekly', interval: 14, untilDate: '2026-09-03' },
          startTime: '16:00',
          title: 'Therapy',
        },
        'Therapy every two weeks on Thursday at 4',
      ),
    ).toMatchObject({ date: '2026-08-27', recurrence: { freq: 'weekly', interval: 2 } });
    // Monthly on a weekday: the Nth such weekday the first one is (the
    // last Wednesday of August).
    expect(
      await prefillOf(
        {
          date: '2026-08-25',
          recurrence: { count: 1, freq: 'weekly', interval: 1, untilDate: '2026-09-01' },
          startTime: '19:00',
          title: 'Book club',
        },
        'Book club every month on Wednesday at 7pm',
      ),
    ).toMatchObject({
      date: '2026-08-26',
      recurrence: { byDay: [{ ordinal: -1, weekday: 'WE' }], freq: 'monthly' },
    });
    expect(
      (
        await prefillOf(
          { startTime: '12:00', title: 'Team lunch' },
          'Team lunch every first Friday at noon',
        )
      ).recurrence,
    ).toEqual({ byDay: [{ ordinal: 1, weekday: 'FR' }], freq: 'monthly' });
    expect(
      (
        await prefillOf(
          { startTime: '07:00', title: 'Yoga' },
          'Yoga alle zwei Wochen am Montag um 7',
        )
      ).recurrence,
    ).toEqual({ freq: 'weekly', interval: 2 });
    expect(
      await prefillOf({ startTime: '19:00', title: 'Stammtisch' }, 'Stammtisch montags um 19 Uhr'),
    ).toMatchObject({ date: '2026-08-24', recurrence: { freq: 'weekly' } });
  });

  it('starts a rule with chosen days on the first of them', async () => {
    // "every weekday" typed on a Saturday: Monday, not a Saturday standup
    // plus the weekdays.
    expect(
      await prefillOf(
        {
          date: '2026-08-22',
          recurrence: { freq: 'weekly' },
          startTime: '09:30',
          title: 'Standup',
        },
        'Standup every weekday at 9:30',
      ),
    ).toMatchObject({ date: '2026-08-24' });
    // The first Friday: a week on from the Friday the phrase lands on.
    expect(
      await prefillOf({ startTime: '12:00', title: 'Lunch' }, 'Lunch every first Friday at noon'),
    ).toMatchObject({ date: '2026-09-04' });
    // Review: a rule that ends before its first day has nothing to
    // repeat — no repeat, and the date as the phrase had it.
    const ended = await prefillOf(
      { recurrence: { freq: 'weekly', untilDate: '2026-08-23' }, startTime: '09:30', title: 'x' },
      'x every weekday at 9:30 until 23 August',
    );
    expect(ended.date).toBe('2026-08-22');
    expect(ended.recurrence).toBeUndefined();
    // Review: the 4th Thursday is the 4th even when it is also the last
    // (Aug 27, not Oct 22).
    expect(
      await prefillOf(
        { date: '2026-08-27', startTime: '19:00', title: 'Book club' },
        'Book club every fourth Thursday at 7pm',
      ),
    ).toMatchObject({
      date: '2026-08-27',
      recurrence: { byDay: [{ ordinal: 4, weekday: 'TH' }], freq: 'monthly' },
    });
  });

  it('counts and spans the repeat as the phrase says', async () => {
    const yoga = { startTime: '07:00', title: 'Yoga' };
    expect((await prefillOf(yoga, 'Yoga every Monday at 7 for 6 weeks')).recurrence).toEqual({
      count: 6,
      freq: 'weekly',
    });
    // A span in another unit ends the rule on its last day.
    expect((await prefillOf(yoga, 'Yoga every day at 7 for two weeks')).recurrence).toEqual({
      freq: 'daily',
      untilDate: '2026-09-04',
    });
    expect((await prefillOf(yoga, 'Yoga every other Tuesday at 7, 10 times')).recurrence).toEqual({
      count: 10,
      freq: 'weekly',
      interval: 2,
    });
    // The model's end stands only behind an until word.
    const ends = { recurrence: { freq: 'weekly', untilDate: '2026-10-31' }, ...yoga } as const;
    expect((await prefillOf(ends, 'Yoga every Monday at 7')).recurrence).toEqual({
      freq: 'weekly',
    });
    expect(
      (await prefillOf(ends, 'Yoga every Monday at 7 until end of October')).recurrence,
    ).toEqual({
      freq: 'weekly',
      untilDate: '2026-10-31',
    });
    expect((await prefillOf(ends, 'Yoga every Monday 7 until 8')).recurrence).toEqual({
      freq: 'weekly',
    });
    // Review: a span on a rule with several days ends it on the span's
    // last day — "every weekday for six weeks" is thirty standups, not
    // six — counted from the Monday it starts on; a span in a smaller
    // unit than the rule's is the event's length, not the series'.
    expect(
      (
        await prefillOf(
          { startTime: '09:00', title: 'Standup' },
          'Standup every weekday for the next 6 weeks at 9',
        )
      ).recurrence,
    ).toEqual({ byDay: WEEKDAYS, freq: 'weekly', untilDate: '2026-10-04' });
    expect(
      (await prefillOf({ title: 'Ski trip' }, 'Ski trip every year for a week')).recurrence,
    ).toEqual({
      freq: 'yearly',
    });
    // Codex: a monthly span ends on its last day rather than counting —
    // from the 31st, two monthly occurrences would reach March 31.
    expect(
      (await prefillOf({ date: '2027-01-31', title: 'Rent' }, 'Rent monthly for two months'))
        .recurrence,
    ).toEqual({ freq: 'monthly', untilDate: '2027-03-30' });
    expect((await prefillOf(yoga, 'Yoga every day at 7 for 10 days')).recurrence).toEqual({
      count: 10,
      freq: 'daily',
    });
    // Codex: a span in days on a weekday rule is its end ("for three
    // days" from a Monday ends Wednesday), and an end weekday after
    // "every Tuesday" is an end, not a range.
    expect(
      (
        await prefillOf(
          { date: '2026-08-24', startTime: '09:00', title: 'Standup' },
          'Standup every weekday at 9 for three days',
        )
      ).recurrence,
    ).toEqual({ byDay: WEEKDAYS, freq: 'weekly', untilDate: '2026-08-26' });
    expect(
      (
        await prefillOf(
          {
            date: '2026-08-25',
            recurrence: { freq: 'weekly', untilDate: '2026-08-28' },
            startTime: '17:00',
            title: 'Piano',
          },
          'Piano every Tuesday at 5pm until Friday',
        )
      ).recurrence,
    ).toEqual({ freq: 'weekly', untilDate: '2026-08-28' });
  });

  it('has no repeat where the phrase names none, or takes it away', async () => {
    // Review: "each", "jeder" and a repeat as a noun are no repeat words,
    // and "no repeat" is heard in a phrase too.
    for (const phrase of [
      'Interviews with each candidate Friday at 10',
      'Grillen am Samstag, jeder bringt was mit',
      'Mathe Wiederholung Dienstag um 10',
      'Dentist Friday at 3, no repeat',
    ]) {
      expect(
        (
          await prefillOf(
            {
              recurrence: { count: 1, freq: 'weekly', interval: 1 },
              startTime: '10:00',
              title: 'x',
            },
            phrase,
          )
        ).recurrence,
        phrase,
      ).toBeUndefined();
    }
    expect(
      (
        await prefillOf(
          { recurrence: { freq: 'weekly' }, startTime: '15:00', title: 'Dentist' },
          'Dentist every Friday at 3, no repeat',
        )
      ).recurrence,
    ).toBeUndefined();
    // Review: a frequency word as an adjective, and "until further
    // notice", with the model's one-week answer.
    const week = { count: 1, freq: 'weekly', interval: 1, untilDate: '2026-08-31' } as const;
    expect(
      (
        await prefillOf(
          { date: '2026-08-28', recurrence: week, startTime: '15:00', title: 'Budget review' },
          'Review the monthly budget with Anna Friday at 3',
        )
      ).recurrence,
    ).toBeUndefined();
    expect(
      (
        await prefillOf(
          { date: '2026-08-24', recurrence: week, startTime: '09:00', title: 'Standup' },
          'Standup every Monday at 9 until further notice',
        )
      ).recurrence,
    ).toEqual({ freq: 'weekly' });
    // Review: "Daily standup every weekday" is the weekdays' rule, started on Monday.
    expect(
      await prefillOf(
        {
          date: '2026-08-22',
          recurrence: { count: 5, freq: 'weekly' },
          startTime: '09:30',
          title: 'Daily standup',
        },
        'Daily standup every weekday at 9:30',
      ),
    ).toMatchObject({ date: '2026-08-24', recurrence: { byDay: WEEKDAYS, freq: 'weekly' } });
  });

  it("keeps the model's frequency only where the words name a repeat without saying which", async () => {
    expect(
      (
        await prefillOf(
          { recurrence: { count: 1, freq: 'monthly' }, startTime: '09:00', title: 'Standup' },
          'Standup at 9, recurring',
        )
      ).recurrence,
    ).toEqual({ freq: 'monthly' });
    // The words say which: the model's is corrected.
    expect(
      (
        await prefillOf(
          { recurrence: { freq: 'daily' }, startTime: '09:00', title: 'Standup' },
          'Standup every week at 9',
        )
      ).recurrence,
    ).toEqual({ freq: 'weekly' });
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
      'Thing daily until december',
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

  it('trims a repeat and its end off the title, and a place that is the title holds nothing', async () => {
    // The bench: the model wrote the whole title into the location for
    // "Standup Monday at 9", which held "Monday" in the title.
    const standup = await prefillOf(
      {
        date: '2026-08-24',
        location: 'Standup Monday',
        startTime: '09:00',
        title: 'Standup Monday',
      },
      'Standup Monday at 9',
    );
    expect(standup).toMatchObject({ date: '2026-08-24', title: 'Standup' });
    // Review: the made-up place is no location either, once the title is trimmed.
    expect(standup.location).toBeUndefined();
    expect(
      await prefillOf(
        {
          date: '2026-08-24',
          location: 'Standup Monday',
          startTime: '09:00',
          title: 'Standup Monday',
        },
        'standup monday at 9',
      ),
    ).toMatchObject({ title: 'Standup' });
    const coffee = await prefillOf(
      { location: 'Coffee Thursday', startTime: '15:00', title: 'Coffee Thursday at 3' },
      'Coffee Thursday at 3',
    );
    expect(coffee.title).toBe('Coffee');
    expect(coffee.location).toBeUndefined();
    // Review: the model's title dropped the repeat but kept its end.
    expect(
      (
        await prefillOf(
          {
            date: '2026-08-25',
            recurrence: { freq: 'weekly', untilDate: '2026-03-01' },
            startTime: '17:00',
            title: 'Piano lesson until March',
          },
          'Piano lesson every Tuesday at 5pm until March',
        )
      ).title,
    ).toBe('Piano lesson');
    expect(
      (
        await prefillOf(
          { date: '2026-08-25', startTime: '18:00', title: 'Jeden Dienstag um 18 Uhr Fußball' },
          'Jeden Dienstag um 18 Uhr Fußball',
        )
      ).title,
    ).toBe('Fußball');
    expect(
      (
        await prefillOf(
          {
            date: '2026-08-25',
            recurrence: { freq: 'weekly', untilDate: '2026-03-01' },
            startTime: '17:00',
            title: 'Piano lesson every Tuesday at 5pm until March',
          },
          'Piano lesson every Tuesday at 5pm until March',
        )
      ).title,
    ).toBe('Piano lesson');
    // A real place keeps its field and leaves the title, as before; one
    // the phrase names without a lead word stays in the title and has no
    // field; a day the code does not read beside it, and a venue that is
    // the whole title, hold their words.
    expect(
      await prefillOf(
        { location: 'Ruby Tuesday', startTime: '19:00', title: 'Dinner at Ruby Tuesday' },
        'Dinner at Ruby Tuesday tomorrow at 7pm',
      ),
    ).toMatchObject({ date: '2026-08-23', location: 'Ruby Tuesday', title: 'Dinner' });
    const inTitle = await prefillOf(
      { location: 'Ruby Tuesday', startTime: '19:00', title: 'Dinner Ruby Tuesday' },
      'Dinner Ruby Tuesday tomorrow 7pm',
    );
    expect(inTitle.title).toBe('Dinner Ruby Tuesday');
    expect(inTitle.location).toBeUndefined();
    // Review: a venue named for a weekday after a place cue, with no other
    // day in the phrase, is still the venue.
    expect(
      await prefillOf(
        { location: 'Ruby Tuesday', startTime: '19:00', title: 'Dinner at Ruby Tuesday' },
        'Dinner at Ruby Tuesday at 7pm',
      ),
    ).toMatchObject({ location: 'Ruby Tuesday', title: 'Dinner' });
    expect(
      await prefillOf(
        { location: 'Café Sonntag', startTime: '15:00', title: 'Kaffee im Café Sonntag' },
        'Kaffee im Café Sonntag um 15 Uhr',
      ),
    ).toMatchObject({ location: 'Café Sonntag', title: 'Kaffee' });
    // Review: a dotted clock, a part of the day and "next week" beside the
    // made-up place are no other day.
    for (const [phrase, parse] of [
      ['Standup Monday at 9.30', { location: 'Standup Monday', title: 'Standup Monday' }],
      ['Kaffee Donnerstag um 15.30', { location: 'Kaffee Donnerstag', title: 'Kaffee Donnerstag' }],
      ['Standup Montag morgen um 9', { location: 'Standup Montag', title: 'Standup Montag' }],
      ['Coffee Thursday at 3 next week', { location: 'Coffee Thursday', title: 'Coffee Thursday' }],
    ] as const) {
      const made = await prefillOf({ ...parse, startTime: '09:00' }, phrase);
      expect(made.title, phrase).toBe(parse.title.split(' ')[0]);
      expect(made.location, phrase).toBeUndefined();
    }
    expect(
      await prefillOf(
        { location: 'Figlmüller', startTime: '19:00', title: 'Dinner at Figlmüller' },
        'Dinner Figlmüller tomorrow 7pm',
      ),
    ).toMatchObject({ location: 'Figlmüller', title: 'Dinner' });
    expect(
      (
        await prefillOf(
          { location: 'Ruby Tuesday', startTime: '19:00', title: 'Ruby Tuesday' },
          'Ruby Tuesday on Sep 3 at 7pm',
        )
      ).title,
    ).toBe('Ruby Tuesday');
    // Codex: an offset from today is another day too; the venue stays.
    expect(
      await prefillOf(
        { location: 'Ruby Tuesday', startTime: '19:00', title: 'Dinner' },
        'Dinner Ruby Tuesday in two days at 7pm',
      ),
    ).toMatchObject({ location: 'Ruby Tuesday', title: 'Dinner' });
    // Codex: a dotted date with a year is a day too.
    expect(
      (
        await prefillOf(
          { location: 'Ruby Tuesday', startTime: '19:00', title: 'Ruby Tuesday' },
          'Ruby Tuesday on 17.10.2026 at 7pm',
        )
      ).title,
    ).toBe('Ruby Tuesday');
  });

  it('takes the days a phrase rules out off the rule, and starts on one it keeps', async () => {
    // The model answers "every day" with a daily rule; said on a Sunday,
    // the first day is the Monday.
    expect(
      await prefillOf(
        { date: '2026-08-23', recurrence: { freq: 'daily' }, startTime: '07:00', title: 'Yoga' },
        'Yoga every day at 7 except Sunday',
      ),
    ).toMatchObject({
      date: '2026-08-24',
      recurrence: { byDay: [...WEEKDAYS, { weekday: 'SA' }], freq: 'weekly' },
      title: 'Yoga',
    });
    expect(
      await prefillOf(
        {
          date: '2026-08-24',
          recurrence: { freq: 'weekly' },
          startTime: '09:00',
          title: 'Standup',
        },
        'Standup jeden Werktag um 9 außer Freitag',
      ),
    ).toMatchObject({
      date: '2026-08-24',
      recurrence: { byDay: WEEKDAYS.slice(0, 4), freq: 'weekly' },
      title: 'Standup',
    });
    // The one day an exception leaves is where the draft lands.
    expect(
      await prefillOf(
        { date: '2026-08-23', recurrence: { freq: 'weekly' }, startTime: '11:00', title: 'Brunch' },
        'Brunch every weekend except Sunday at 11',
      ),
    ).toMatchObject({
      date: '2026-08-29',
      recurrence: { byDay: [{ weekday: 'SA' }], freq: 'weekly' },
    });
    // Review: a "but not" about people leaves the day and the venue alone.
    expect(
      await prefillOf(
        {
          date: '2026-08-28',
          location: 'Ruby Tuesday',
          startTime: '19:00',
          title: 'Dinner Ruby Tuesday',
        },
        'Dinner Ruby Tuesday but not with Anna on Friday',
      ),
    ).toMatchObject({ date: '2026-08-28', title: 'Dinner Ruby Tuesday' });
  });

  it('drops a repeat the phrase never named', async () => {
    // Observed: "next Tuesday" came back as a weekly repeat, count 1 — and
    // "Standup Monday at 9" as a week of them.
    const prefill = await prefillOf(
      { recurrence: { count: 1, freq: 'weekly' }, startTime: '13:00', title: 'Lunch' },
      'Lunch next Tuesday at 1',
    );
    expect(prefill.recurrence).toBeUndefined();
    expect(prefill.date).toBe('2026-08-25');
    const standup = { date: '2026-08-24', startTime: '09:00', title: 'Standup' };
    expect(
      (
        await prefillOf(
          {
            ...standup,
            recurrence: { count: 1, freq: 'weekly', interval: 1, untilDate: '2026-08-31' },
          },
          'Standup Monday at 9',
        )
      ).recurrence,
    ).toBeUndefined();
    expect(
      (await prefillOf({ ...standup, recurrence: { freq: 'weekly' } }, 'Standup Monday at 9'))
        .recurrence,
    ).toBeUndefined();
  });

  it('reads a repeat end before the first day as next year', async () => {
    expect(await untilOf('2026-03-31')).toBe('2027-03-31');
    expect(await untilOf('2026-12-31')).toBe('2026-12-31');
    expect(await untilOf('2026-08-23')).toBe('2026-08-23');
    // Codex: an end on the first day leaves nothing to repeat — no rule,
    // not an endless one.
    expect(
      (
        await prefillOf(
          {
            recurrence: { freq: 'daily', untilDate: '2026-08-22' },
            startTime: '07:00',
            title: 'Yoga',
          },
          'Yoga every day at 7 until 22 August',
        )
      ).recurrence,
    ).toBeUndefined();
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
      { recurrence: { freq: 'biannual' as never }, startTime: '09:00', title: 'Standup' },
      'Standup at 9, repeating',
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

  it('keeps a venue named for a day whole, in its field', async () => {
    // Codex: "Dinner at Ruby" with the place "Ruby Tuesday".
    expect(
      await prefillOf(
        { location: 'Ruby Tuesday', title: 'Dinner at Ruby Tuesday' },
        'Dinner at Ruby Tuesday tomorrow',
      ),
    ).toMatchObject({ date: '2026-08-23', location: 'Ruby Tuesday', title: 'Dinner' });
  });

  it('keeps a venue that is the whole title', async () => {
    // Codex round 2: the second trim ran without the place.
    expect(
      (
        await prefillOf(
          { location: 'Ruby Tuesday', title: 'Ruby Tuesday' },
          'Ruby Tuesday tomorrow',
        )
      ).title,
    ).toBe('Ruby Tuesday');
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

  it('takes the spoken command off the title', async () => {
    // Observed on the iPhone (2026-11-06): the model echoed the dictated
    // sentence, command and all; the Mac's model drops the command, so
    // the bench never saw it.
    expect(
      await prefillOf(
        { startTime: '13:00', title: 'Add an event to have lunch with Stefan tomorrow at 1' },
        'Add an event to have lunch with Stefan tomorrow at 1',
      ),
    ).toMatchObject({ date: '2026-08-23', startTime: '13:00', title: 'Lunch with Stefan' });
    // The same PR on the iPhone (2026-11-09): the recognizer wrote "Add"
    // as "At", and the day came before the company.
    expect(
      await prefillOf(
        { title: 'At an event for lunch tomorrow with Stefan' },
        'At an event for lunch tomorrow with Stefan',
      ),
    ).toMatchObject({ date: '2026-08-23', title: 'Lunch with Stefan' });
    // The Mac's model on the same words: the verb gone, the placeholder kept.
    expect(
      (
        await prefillOf(
          { title: 'Event for lunch with Stefan' },
          'At an event for lunch tomorrow with Stefan',
        )
      ).title,
    ).toBe('Lunch with Stefan');
    // Codex: the closing "please" such a title kept goes too, and the when after it.
    expect(
      (
        await prefillOf(
          { title: 'Event for lunch tomorrow please' },
          'Add an event for lunch tomorrow please',
        )
      ).title,
    ).toBe('Lunch');
    expect(
      (
        await prefillOf(
          { startTime: '13:00', title: 'Add lunch tomorrow at 1 with Stefan' },
          'Add lunch tomorrow at 1 with Stefan',
        )
      ).title,
    ).toBe('Lunch with Stefan');
    // A title the model kept the lead in (the bench's long phrases).
    expect(
      await prefillOf(
        { location: 'Loos Bar', startTime: '19:00', title: 'Set up a dinner with Tom Baker' },
        'Set up a dinner with Tom Baker next Friday at seven at Loos Bar',
      ),
    ).toMatchObject({ location: 'Loos Bar', title: 'Dinner with Tom Baker' });
    // German: the when and the article between the verb and the event.
    expect(
      await prefillOf(
        {
          location: 'Praxis Dr. Huber',
          startTime: '10:00',
          title:
            'Trag mir für nächsten Mittwoch um 10 Uhr einen Zahnarzttermin in der Praxis Dr. Huber ein',
        },
        'Trag mir für nächsten Mittwoch um 10 Uhr einen Zahnarzttermin in der Praxis Dr. Huber ein',
      ),
    ).toMatchObject({ location: 'Praxis Dr. Huber', title: 'Zahnarzttermin' });
    expect(
      (
        await prefillOf(
          { startTime: '10:00', title: 'Trag mir morgen um 10 einen Zahnarzttermin ein' },
          'Trag mir morgen um 10 einen Zahnarzttermin ein',
        )
      ).title,
    ).toBe('Zahnarzttermin');
    // The command's "for" before the when, and the tail that says where the event goes.
    expect(
      await prefillOf(
        { startTime: '13:00', title: 'Put lunch with Stefan on my calendar for tomorrow at 1' },
        'Put lunch with Stefan on my calendar for tomorrow at 1',
      ),
    ).toMatchObject({ date: '2026-08-23', startTime: '13:00', title: 'Lunch with Stefan' });
    // Bench (Apple's model): the verb kept, the tail dropped — the phrase shows the command.
    expect(
      (
        await prefillOf(
          { startTime: '13:00', title: 'Put lunch with Stefan' },
          'Put lunch with Stefan on my calendar for tomorrow at 1',
        )
      ).title,
    ).toBe('Lunch with Stefan');
    // German puts the when between the verb and the event.
    expect(
      (
        await prefillOf(
          { startTime: '10:00', title: 'Trag mir am Dienstag um 10 einen Zahnarzttermin ein' },
          'Trag mir am Dienstag um 10 einen Zahnarzttermin ein',
        )
      ).title,
    ).toBe('Zahnarzttermin');
    // The noun stays where nothing but when follows.
    expect(
      (await prefillOf({ startTime: '09:00', title: 'Add an event' }, 'Add an event tomorrow at 9'))
        .title,
    ).toBe('Event');
    // A to-do's command, with its cue.
    expect(
      await parseQuickAdd(fakeModel({ title: 'Add a reminder to call the bank tomorrow' }), {
        phrase: 'Add a reminder to call the bank tomorrow',
        ...CONTEXT,
      }),
    ).toMatchObject({ kind: 'task', prefill: { date: '2026-08-23', title: 'Call the bank' } });
    // Review: a to-do's words are what to do, whether the model kept the
    // cue or the whole phrase stands in.
    expect(
      await parseQuickAdd(fakeModel({ title: 'add milk' }), {
        phrase: 'remind me to add milk tomorrow',
        ...CONTEXT,
      }),
    ).toMatchObject({ kind: 'task', prefill: { title: 'Add milk' } });
    for (const title of ['Schedule the car service', 'remind me to schedule the car service']) {
      expect(
        await parseQuickAdd(fakeModel({ title }), {
          phrase: 'remind me to schedule the car service',
          ...CONTEXT,
        }),
      ).toMatchObject({ kind: 'task', prefill: { title: 'Schedule the car service' } });
    }
    // Review: a meeting is the event; the place stays in its field.
    expect(
      await prefillOf(
        { location: 'Café Central', startTime: '15:00', title: 'Add a meeting at Café Central' },
        'Add a meeting at Café Central tomorrow at 3',
      ),
    ).toMatchObject({ location: 'Café Central', title: 'Meeting' });
    expect(
      (
        await prefillOf(
          { title: 'Add a meeting for tomorrow with Tom' },
          'Add a meeting for tomorrow with Tom',
        )
      ).title,
    ).toBe('Meeting with Tom');
    // Review round 2: "the calendar" beside a command, before the when.
    expect(
      (
        await prefillOf(
          { startTime: '13:00', title: 'Add lunch with Tom to the calendar tomorrow at 1' },
          'Add lunch with Tom to the calendar tomorrow at 1',
        )
      ).title,
    ).toBe('Lunch with Tom');
    expect(
      (
        await prefillOf(
          {
            startTime: '13:00',
            title: 'Trag Mittagessen mit Stefan morgen um 13 Uhr in den Kalender ein',
          },
          'Trag Mittagessen mit Stefan morgen um 13 Uhr in den Kalender ein',
        )
      ).title,
    ).toBe('Mittagessen mit Stefan');
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

describe('parseQuickAdd reads the note and the notifications beside the event', () => {
  it('returns them beside the prefill and shows the model only the event', async () => {
    const model = fakeModel({ date: '2026-08-25', startTime: '10:00', title: 'Dentist' });
    const result = await parseQuickAdd(model, {
      phrase: 'Dentist Tuesday at 10, remind me 30 minutes before, note: bring the card',
      ...CONTEXT,
    });
    expect(result).toEqual({
      kind: 'parsed',
      notes: { kind: 'add', text: 'bring the card' },
      prefill: {
        date: '2026-08-25',
        endTime: '11:00',
        isAllDay: false,
        startTime: '10:00',
        title: 'Dentist',
      },
      reminders: { add: [30], clear: false, remove: [] },
    });
    for (const prompt of model.prompts) {
      expect(prompt).not.toContain('remind me');
      expect(prompt).not.toContain('bring the card');
    }
    expect(model.prompts[0]).toContain('Phrase: Dentist Tuesday at 10');
  });

  it('is an event with a notification, not a to-do, and the lead is not its length', async () => {
    const result = await parseQuickAdd(
      fakeModel({ date: '2026-08-25', startTime: '10:00', title: 'Zahnarzt' }),
      { phrase: 'Zahnarzt Dienstag um 10, erinnere mich 15 Minuten vorher', ...CONTEXT },
    );
    expect(result).toMatchObject({
      kind: 'parsed',
      prefill: { endTime: '11:00', startTime: '10:00', title: 'Zahnarzt' },
      reminders: { add: [15], clear: false, remove: [] },
    });
    // The to-do cue stays one: a note rides on the to-do, notifications do not.
    const todo = await parseQuickAdd(fakeModel({ title: 'call the bank' }), {
      phrase: 'remind me to call the bank tomorrow, note: ask about the fee',
      ...CONTEXT,
    });
    expect(todo).toEqual({
      kind: 'task',
      notes: { kind: 'add', text: 'ask about the fee' },
      prefill: { date: '2026-08-23', title: 'Call the bank' },
    });
  });

  it('rejects a note or notification with nothing to schedule, without the model', async () => {
    const model = fakeModel({ title: 'unused' });
    const result = await parseQuickAdd(model, {
      phrase: 'remind me 30 minutes before',
      ...CONTEXT,
    });
    expect(result).toEqual({ kind: 'rejected', reason: 'Say what to schedule first.' });
    expect(model.prompts).toHaveLength(0);
  });
});

/** What a phrase comes to; `title` is the model's, the phrase itself where a model echoes it. */
const placed = async (phrase: string, title: string = phrase, people?: ReadonlyArray<string>) => {
  const { location, title: titled } = await prefillOf(
    { ...(people === undefined ? {} : { people }), title },
    phrase,
  );
  return { location, title: titled };
};

/** The place of a phrase the reader must leave as it was: none. */
const unplaced = async (phrase: string, title: string = phrase) =>
  (await placed(phrase, title)).location;

describe('parseQuickAdd reads the place from the phrase when the model names none', () => {
  it('takes a venue said with its kind, whether the model dropped it or kept it in the title', async () => {
    // The bench, Apple's model on the Mac: a title and nothing else.
    expect(await placed('Coffee tomorrow at 10 at Café Prückel', 'Coffee')).toEqual({
      location: 'Café Prückel',
      title: 'Coffee',
    });
    expect(await placed('drinks with jo at Loos Bar friday 7pm', 'drinks with jo')).toEqual({
      location: 'Loos Bar',
      title: 'Drinks with jo',
    });
    expect(
      await placed('Dinner at Hard Rock Cafe on Friday at 7', 'Dinner at Hard Rock Cafe'),
    ).toEqual({ location: 'Hard Rock Cafe', title: 'Dinner' });
    // A model that echoes the phrase (the iPhone's).
    expect(await placed('Coffee tomorrow at 10 at Café Prückel')).toEqual({
      location: 'Café Prückel',
      title: 'Coffee',
    });
    expect(await placed('Lunch @ Loos Bar')).toEqual({ location: 'Loos Bar', title: 'Lunch' });
  });

  it("keeps a venue's name whole after its kind, joints and all", async () => {
    expect(await placed('Dinner at Café am Heumarkt Friday')).toEqual({
      location: 'Café am Heumarkt',
      title: 'Dinner',
    });
    expect(await placed('Abend im Haus der Musik')).toEqual({
      location: 'Haus der Musik',
      title: 'Abend',
    });
    expect(await placed('Standup at room 4 tomorrow')).toEqual({
      location: 'room 4',
      title: 'Standup',
    });
  });

  it('reads no name that no kind of place says is one', async () => {
    // Review (Opus): after "at" a capital is a holiday, a deadline, an
    // occasion, a person or their employer as often as a venue.
    for (const [phrase, title] of [
      ['Visit family at Thanksgiving', 'Visit family'],
      ['Costume party at Halloween', 'Costume party'],
      ['Send report at EOD', 'Send report'],
      ['Call back at COB Friday', 'Call back'],
      ['Deploy @ EOD', 'Deploy'],
      ['Lunch at TBD', 'Lunch'],
      ['Deadline at Month End', 'Deadline'],
      ['Present roadmap at All Hands Friday', 'Present roadmap'],
      ['Bring up budget at Standup', 'Bring up budget'],
      ['Demo at Sprint Review', 'Demo'],
      ['Call Tom at Microsoft tomorrow', 'Call Tom'],
      ['Email Anna at Acme', 'Email Anna'],
      ['Party at Anna', 'Party'],
      ['Aim at Target', 'Aim'],
      // A venue all the same: only the model or the lookup can say so.
      ["Dinner at Luigi's Friday", 'Dinner'],
      ['Lunch with Sam tomorrow at 12:30 at Mercato', 'Lunch with Sam'],
      ['Meet at Am Hof at 10', 'Meet'],
      ['Dinner at The Standard on Friday', 'Dinner'],
      ['Demo at Visual Studio Live', 'Demo'],
    ] as const) {
      expect(await unplaced(phrase, title), phrase).toBeUndefined();
      expect(await unplaced(phrase), phrase).toBeUndefined();
    }
  });

  it('takes a kind first only where it titles a venue: an occasion begins with one too', async () => {
    for (const phrase of [
      'Drinks at Office Party',
      'Ask about grades at Office Hours Tuesday',
      'Dance at House Party Saturday',
      'Party at the Bar Mitzvah Saturday',
      'Shop at Home Depot',
    ]) {
      expect(await unplaced(phrase), phrase).toBeUndefined();
    }
  });

  it('reads no place that goes on into a when the trim left', async () => {
    // Review (Opus): German writes "Abend" and "Juni" with a name's capital.
    for (const [phrase, title] of [
      ['Treffen im Café Prückel am Abend', 'Treffen'],
      ['Meeting im Büro am Vormittag', 'Meeting'],
      ['Mittagessen in der Kantine am Mittag', 'Mittagessen'],
      ['Kaffee im Café Central im Juni', 'Kaffee'],
      ['Konzert im Konzerthaus im Mai', 'Konzert'],
      ['Besprechung im Büro im Sommer', 'Besprechung'],
      ['Essen im Restaurant Plachutta am Wochenende', 'Essen'],
      ['Sport im Fitnessstudio am Morgen', 'Sport'],
      ['Kaffee im Café Central Anfang Juni', 'Kaffee'],
      ['Meeting im Büro Mittagessen', 'Meeting'],
      ['Drinks @ Loos Bar am Abend', 'Drinks'],
      // A count is no part of a name.
      ['Coffee at Café Prückel 3x weekly', 'Coffee'],
      ['Run at the Park 5K Saturday', 'Run'],
    ] as const) {
      expect(await unplaced(phrase, title), phrase).toBeUndefined();
      expect(await unplaced(phrase), phrase).toBeUndefined();
    }
  });

  it('takes "in die Oper" for where to go, and "is in the office" for a clause', async () => {
    for (const phrase of [
      'Mit Anna in die Oper',
      'Mit den Kindern in das Museum',
      'Ausflug in den Park',
      'Mit Lisa in ein Café',
      'Lunch with whoever is in the office',
      'Security training in house on Friday',
      'Mass in church on Sunday',
    ]) {
      expect(await unplaced(phrase), phrase).toBeUndefined();
    }
    expect(await placed('Mit Anna in der Oper')).toEqual({ location: 'Oper', title: 'Mit Anna' });
  });

  it('reads past a clock said in words to the place after it', async () => {
    expect(await placed('Call at half past three at the office')).toEqual({
      location: 'office',
      title: 'Call',
    });
  });

  it('tells no name by its capital in a phrase written in title case or capitals', async () => {
    for (const phrase of [
      "Team Lunch At Luigi's With The Whole Crew",
      "Dinner At Luigi's Bring Wine",
      'Coffee At Café Prückel With Jo',
      'DINNER AT LUIGIS WITH JO',
      'Call Mom At Once',
    ]) {
      expect(await unplaced(phrase), phrase).toBeUndefined();
    }
    // The kind still says it.
    expect(await placed('Dinner At Loos Bar')).toEqual({ location: 'Loos Bar', title: 'Dinner' });
  });

  it('takes a place said by what it is, after "at", "in" and "im"', async () => {
    expect(
      await placed('Project review Wednesday at 11 in the big meeting room', 'Project review'),
    ).toEqual({ location: 'big meeting room', title: 'Project review' });
    expect(await placed('Project review Wednesday at 11 in the big meeting room')).toEqual({
      location: 'big meeting room',
      title: 'Project review',
    });
    expect(await placed('Meeting at the office tomorrow')).toEqual({
      location: 'office',
      title: 'Meeting',
    });
    expect(await placed('Yoga at home tomorrow')).toEqual({ location: 'home', title: 'Yoga' });
    expect(await placed('Meeting in the Vienna office Monday')).toEqual({
      location: 'Vienna office',
      title: 'Meeting',
    });
    // Typed in lower case: the kind says it, not the capitals.
    expect(await placed('drinks with jo at loos bar friday 7pm')).toEqual({
      location: 'loos bar',
      title: 'Drinks with jo',
    });
    // German names the kind first, or builds it into one word.
    expect(await placed('Kaffee morgen um 15 Uhr im Café Prückel', 'Kaffee')).toEqual({
      location: 'Café Prückel',
      title: 'Kaffee',
    });
    expect(await placed('Meeting im Büro morgen um 9')).toEqual({
      location: 'Büro',
      title: 'Meeting',
    });
    expect(await placed('Besprechung im großen Besprechungsraum um 14 Uhr')).toEqual({
      location: 'großen Besprechungsraum',
      title: 'Besprechung',
    });
    expect(await placed('Konzert im Konzerthaus am Freitag um 19:30')).toEqual({
      location: 'Konzerthaus',
      title: 'Konzert',
    });
    expect(await placed('Termin in der Zahnarztpraxis am Montag')).toEqual({
      location: 'Zahnarztpraxis',
      title: 'Termin',
    });
  });

  it('reads past the command and the invitation around the event', async () => {
    expect(
      await placed(
        'Trag mir für nächsten Mittwoch um 10 Uhr einen Zahnarzttermin in der Praxis Dr. Huber ein',
        'Zahnarzttermin',
      ),
    ).toEqual({ location: 'Praxis Dr. Huber', title: 'Zahnarzttermin' });
    expect(
      await placed(
        'Set up a dinner with Tom Baker next Friday at seven at Loos Bar, invite Anna Lee too',
        'dinner with Tom Baker',
        ['Anna Lee'],
      ),
    ).toEqual({ location: 'Loos Bar', title: 'Dinner with Tom Baker' });
    // No one read as invited: the clause after the comma is not understood.
    expect(
      await unplaced(
        'Set up a dinner with Tom Baker next Friday at seven at Loos Bar, invite Anna Lee too',
        'dinner with Tom Baker',
      ),
    ).toBeUndefined();
    // "check in" is not where; the hotel is.
    expect(await placed('Check in at the hotel tomorrow')).toEqual({
      location: 'hotel',
      title: 'Check in',
    });
    expect(await placed('Check in with Tom at Loos Bar')).toEqual({
      location: 'Loos Bar',
      title: 'Check in with Tom',
    });
  });

  it('reads no bare name after "im" or "in": the words do not tell it from a manner or a topic', async () => {
    // Measured on Apple's model on the Mac: it cuts the title at the when
    // whatever follows, so these lose their end alike, and asked for the
    // place alone it names "Regen" and "Bett" too.
    expect(await placed('Kaffee mit Max um 10 Uhr im Figlmüller', 'Kaffee mit Max')).toEqual({
      location: undefined,
      title: 'Kaffee mit Max',
    });
    expect(await placed('Laufen morgen um 7 im Regen', 'Laufen')).toEqual({
      location: undefined,
      title: 'Laufen',
    });
    for (const [phrase, title] of [
      ['Essen morgen um 19 Uhr im Schwarzen Kameel', 'Essen'],
      ['Lesen heute um 21 Uhr im Bett', 'Lesen'],
      ['Wandern am Samstag um 9 im Schnee', 'Wandern'],
      ['Besprechung morgen um 10 im Team', 'Besprechung'],
      ['Abendessen am Sonntag um 18 Uhr im Kreis der Familie', 'Abendessen'],
      ['Dinner Friday at 7 in Vienna', 'Dinner'],
      ['Presentation Friday at 2 in English', 'Presentation'],
    ] as const) {
      expect(await unplaced(phrase, title), phrase).toBeUndefined();
      expect(await unplaced(phrase), phrase).toBeUndefined();
    }
    // The kind says what the name cannot.
    expect(await placed('Bier morgen um 18 Uhr im Schweizerhaus', 'Bier')).toEqual({
      location: 'Schweizerhaus',
      title: 'Bier',
    });
    expect(await placed('Termin im Rathaus am Montag um 9')).toEqual({
      location: 'Rathaus',
      title: 'Termin',
    });
  });

  it('never takes a clock, a when or company for a place', async () => {
    for (const phrase of [
      'Lunch at 7',
      'Lunch at noon',
      'Call at half past three',
      'Dinner with Tom at seven',
      'Standup at 9:30',
      'Party at night',
      'Talk to Tom at lunch',
      'Party at Christmas',
      'Brunch at Easter',
      'Sync at the weekend',
      'Call in the morning',
      'Call in two weeks',
      'Lunch in an hour',
      'Review in 10 minutes',
      'New York trip in May',
      'Planning in the next sprint',
      'Urlaub im Mai',
      'Skifahren im Winter',
      'Termin im Jänner',
      'Lunch with Tom',
      'Essen mit Anna',
    ]) {
      expect(await unplaced(phrase), phrase).toBeUndefined();
    }
    // The same when the model's title dropped the words.
    expect(await unplaced('Urlaub im Mai', 'Urlaub')).toBeUndefined();
    expect(await unplaced('Brunch at Easter', 'Brunch')).toBeUndefined();
    expect(await unplaced('Submit report Friday at the latest', 'Submit report')).toBeUndefined();
  });

  it('leaves what "at" does not lead into as a place', async () => {
    for (const phrase of [
      // What is looked at.
      "Look at Anna's slides tomorrow",
      'Look at Tesla Model 3 Saturday',
      'Take a look at the new office',
      // Words that go on after it, a second clause, an address.
      'Dinner at Loos Bar with Jo tomorrow',
      'Coffee at Starbucks before work',
      'Dinner at Marks and Spencer',
      "Lunch at Luigi's, bring wine",
      'Email Tom at tom@example.com',
      // Lower-case words that name no kind of place.
      'coffee at starbucks tomorrow',
      'Call mom at least once',
      // Nothing but a when before it, and the lead as the first word.
      'Tomorrow at Loos Bar',
      'At Loos Bar',
      // A name that begins with a when: no telling.
      'Breakfast at Morning Glory',
      'Dinner at Friday Harbor',
    ]) {
      expect(await unplaced(phrase), phrase).toBeUndefined();
    }
    expect(await unplaced('coffee at starbucks tomorrow', 'coffee')).toBeUndefined();
    // "At an event …" is "Add an event …" as dictation hears it.
    expect(await placed('At an event for lunch tomorrow with Stefan')).toEqual({
      location: undefined,
      title: 'Lunch with Stefan',
    });
  });

  it('leaves what "in" does not lead into as a place', async () => {
    for (const phrase of [
      // A name after "in" is as often a language, a tool, a topic.
      'Dinner in Vienna Friday',
      'Meeting in German on Friday',
      'Review designs in Figma',
      'Set up rules in Office 365',
      'Review automations in Home Assistant',
      'Standup in room 4',
      // No kind of place, or one that is not what the words end in.
      'Fix typo in the report tomorrow',
      'Meet Tom in person',
      'Hand in the office keys',
      'Fix bug in the office app',
      'Book club: The Catcher in the Rye',
      'Sign in sheet at the office',
      'Interview at the office for the PM role',
    ]) {
      expect(await unplaced(phrase), phrase).toBeUndefined();
    }
    expect(await unplaced('Dinner in Vienna Friday', 'Dinner')).toBeUndefined();
    expect(await unplaced('Fix typo in the report tomorrow', 'Fix typo')).toBeUndefined();
  });

  it('reads no place the words rule out', async () => {
    // Review (Codex): "Meeting tomorrow not at the office" was "Meeting
    // tomorrow not" at "office".
    expect(await placed('Meeting tomorrow not at the office')).toEqual({
      location: undefined,
      title: 'Meeting tomorrow not at the office',
    });
    for (const phrase of [
      'Lunch but not at Loos Bar',
      'Dinner, never at the office',
      "Team sync, we can't meet at the office",
      'Standup anywhere except at the office',
      'Treffen nicht im Büro',
      'Besprechung, aber keinesfalls im Café Prückel',
    ]) {
      expect(await unplaced(phrase), phrase).toBeUndefined();
    }
  });

  it('reads no lead inside a quoted title, nor in a work that is watched or read', async () => {
    // Review (Codex): the book lost its end to the place field.
    expect(await placed('Read "The House at Pooh Corner" tomorrow')).toEqual({
      location: undefined,
      title: 'Read "The House at Pooh Corner"',
    });
    expect(await unplaced('Book club: “A Night at the Office” on Friday')).toBeUndefined();
    expect(await unplaced('Lesekreis: „Frühstück im Hotel“ am Freitag')).toBeUndefined();
    // A venue in quotes after a lead outside them, and a lead after the quote.
    expect(await placed('Dinner at "Loos Bar" tomorrow')).toEqual({
      location: 'Loos Bar',
      title: 'Dinner',
    });
    expect(await placed('Discuss "The House at Pooh Corner" at the office tomorrow')).toEqual({
      location: 'office',
      title: 'Discuss "The House at Pooh Corner"',
    });
    // Without quotes the opening verb says it is a work.
    for (const phrase of [
      "Watch Breakfast at Tiffany's tonight",
      'Watch Night at the Museum tomorrow',
      'Read Fast Times at Ridgemont High',
      'Rewatch Live at Wembley',
    ]) {
      expect(await unplaced(phrase), phrase).toBeUndefined();
    }
  });

  it('takes a kind after "in" only as a common noun: a capital makes it a name', async () => {
    // Review (Codex): "Debug code in Visual Studio tomorrow" was "Debug
    // code" at "Visual Studio".
    for (const phrase of [
      'Debug code in Visual Studio tomorrow',
      'Bugfix in Android Studio',
      'Set up lights in Google Home',
      'Change the setting in the Control Center',
      'Check alerts in the Security Center',
      'Walk in Central Park',
    ]) {
      expect(await unplaced(phrase), phrase).toBeUndefined();
    }
    expect(await placed('Meeting in the Vienna office Monday')).toEqual({
      location: 'Vienna office',
      title: 'Meeting',
    });
    expect(await placed('Lunch in the canteen')).toEqual({ location: 'canteen', title: 'Lunch' });
    // German writes every kind with a capital, and is known by its article.
    expect(await placed('Termin in der Praxis Dr. Huber')).toEqual({
      location: 'Praxis Dr. Huber',
      title: 'Termin',
    });
    expect(await placed('Probe in der Tanzschule am Montag')).toEqual({
      location: 'Tanzschule',
      title: 'Probe',
    });
  });

  it('reads no other lead: where to go, with whom, "am"', async () => {
    for (const [phrase, title] of [
      ['Mit Anna ins Kino', 'Mit Anna'],
      ['Fahrt zum Flughafen', 'Fahrt'],
      ['Essen bei Anna', 'Essen'],
      ['Termin beim Zahnarzt', 'Termin'],
      ['Treffen am Hof um 10', 'Treffen'],
      ['Trip to Vienna on Saturday', 'Trip'],
    ] as const) {
      expect(await unplaced(phrase, title), phrase).toBeUndefined();
      expect(await unplaced(phrase), phrase).toBeUndefined();
    }
  });

  it('leaves a weekday that may be the name’s as it was', async () => {
    // "Ruby Tuesday" needs the model to say so; "Ruby" alone is no place to claim.
    expect(await placed('Dinner at Ruby Tuesday tomorrow', 'Dinner at Ruby Tuesday')).toEqual({
      location: undefined,
      title: 'Dinner at Ruby',
    });
    // One day after the place is the event's.
    expect(await placed('Dinner at Loos Bar Tuesday')).toEqual({
      location: 'Loos Bar',
      title: 'Dinner',
    });
  });

  it('keeps the model’s place where it names one, and reads the words where its place is none', async () => {
    expect(
      await prefillOf({ location: 'Figlmüller', title: 'Lunch' }, 'Lunch at Figlmüller'),
    ).toMatchObject({ location: 'Figlmüller', title: 'Lunch' });
    // Made up, not in the words.
    expect(
      await prefillOf(
        { location: 'Vienna', title: 'Coffee' },
        'Coffee tomorrow at 10 at Café Prückel',
      ),
    ).toMatchObject({ location: 'Café Prückel', title: 'Coffee' });
    expect(
      await prefillOf({ location: 'unknown', title: 'Coffee' }, 'Coffee at Café Prückel'),
    ).toMatchObject({ location: 'Café Prückel', title: 'Coffee' });
  });

  it('gives a to-do no place, and capture the model’s as it is', async () => {
    expect(
      await parseQuickAdd(fakeModel({ title: 'pick up the keys at the office' }), {
        phrase: 'remind me to pick up the keys at the office tomorrow',
        ...CONTEXT,
      }),
    ).toEqual({
      kind: 'task',
      prefill: { date: '2026-08-23', title: 'Pick up the keys at the office' },
    });
    expect(
      normalizeQuickAdd(
        { date: '2026-08-25', location: 'at the office', title: 'Meeting' },
        CONTEXT,
      ),
    ).toMatchObject({ kind: 'parsed', prefill: { location: 'at the office', title: 'Meeting' } });
  });

  it('takes the lead a model copied off its place where the words prove it one', async () => {
    expect(
      await prefillOf(
        { location: 'at the office', title: 'Meeting at the office' },
        'Meeting at the office tomorrow',
      ),
    ).toMatchObject({ location: 'office', title: 'Meeting' });
    expect(
      await prefillOf(
        { location: 'in der Praxis Dr. Huber', title: 'Zahnarzt' },
        'Zahnarzt morgen um 10 in der Praxis Dr. Huber',
      ),
    ).toMatchObject({ location: 'Praxis Dr. Huber', title: 'Zahnarzt' });
    expect(
      await prefillOf({ location: 'im Büro', title: 'Meeting' }, 'Meeting im Büro'),
    ).toMatchObject({ location: 'Büro', title: 'Meeting' });
    // A name may begin with the same word: only the lookup can tell.
    expect(
      await prefillOf({ location: 'im Figlmüller', title: 'Kaffee' }, 'Kaffee im Figlmüller'),
    ).toMatchObject({ location: 'im Figlmüller', title: 'Kaffee' });
    expect(
      await prefillOf({ location: 'Am Hof', title: 'Kaffee' }, 'Kaffee Am Hof um 10'),
    ).toMatchObject({ location: 'Am Hof', title: 'Kaffee' });
    // Review (Opus): without its lead the place was the title over again,
    // and went. The model's own text stands, as it did.
    expect(
      await prefillOf({ location: 'at the gym', title: 'Gym' }, 'Gym at the gym tomorrow'),
    ).toMatchObject({ location: 'at the gym', title: 'Gym' });
  });
});
