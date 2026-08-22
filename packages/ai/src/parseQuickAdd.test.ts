import { describe, expect, it } from 'vitest';
import type { LanguageModel } from './model.ts';
import { ModelUnavailableError } from './model.ts';
import { parseQuickAdd } from './parseQuickAdd.ts';
import type { QuickAddParse } from './quickAdd.ts';

const CONTEXT = { referenceDate: '2026-08-22', timeZone: 'Europe/Vienna' };

/** A model that replays a fixed extraction, recording the prompt it saw. */
const fakeModel = (
  parse: QuickAddParse | (() => never),
  { available = true }: { available?: boolean } = {},
): LanguageModel & { prompts: Array<string> } => {
  const prompts: Array<string> = [];
  return {
    generateJson: async ({ prompt }) => {
      prompts.push(prompt);
      return typeof parse === 'function' ? parse() : parse;
    },
    isAvailable: async () => available,
    prompts,
  };
};

const prefillOf = async (parse: QuickAddParse, phrase = 'anything') => {
  const result = await parseQuickAdd(fakeModel(parse), { phrase, ...CONTEXT });
  if (result.kind !== 'parsed') {
    throw new Error(`expected a parse, got: ${result.reason}`);
  }
  return result.prefill;
};

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
    // normalizer must not anglicise or drop the title.
    const prefill = await prefillOf(
      { date: '2026-08-25', startTime: '14:30', title: 'Zahnarzt' },
      'Zahnarzt nächsten Dienstag um halb drei',
    );
    expect(prefill.title).toBe('Zahnarzt');
    expect(prefill.startTime).toBe('14:30');
    expect(prefill.endTime).toBe('15:30');
  });

  it('gives a bare start time a one-hour default', async () => {
    const prefill = await prefillOf({ startTime: '09:00', title: 'Standup' });
    expect(prefill).toMatchObject({ endTime: '10:00', isAllDay: false, startTime: '09:00' });
  });

  it('treats a backwards or equal end time as unusable and defaults it', async () => {
    expect((await prefillOf({ endTime: '08:00', startTime: '09:00', title: 'x' })).endTime).toBe(
      '10:00',
    );
    expect((await prefillOf({ endTime: '09:00', startTime: '09:00', title: 'x' })).endTime).toBe(
      '10:00',
    );
  });

  it('clamps rather than spilling past midnight', async () => {
    expect((await prefillOf({ startTime: '23:30', title: 'Late' })).endTime).toBe('23:59');
  });

  it('falls back to all-day when no time was stated', async () => {
    const prefill = await prefillOf({ date: '2026-09-01', title: 'Conference' });
    expect(prefill).toMatchObject({ isAllDay: true, startTime: '00:00' });
  });

  it('defaults the date to today when the phrase gave none', async () => {
    expect((await prefillOf({ startTime: '09:00', title: 'Standup' })).date).toBe('2026-08-22');
  });

  it('carries a recurrence through as editor fields', async () => {
    const prefill = await prefillOf({
      recurrence: { count: 5, freq: 'weekly', interval: 2 },
      startTime: '10:00',
      title: 'Retro',
    });
    // The editor's own fields, so the user sees and can adjust them before
    // the existing save path builds the RRULE.
    expect(prefill.recurrence).toEqual({ count: 5, freq: 'weekly', interval: 2 });
  });

  it('ignores junk the model invented instead of trusting the schema', async () => {
    // Schema-shaped but semantically wrong: an impossible time, a bad date,
    // and a recurrence end that isn't a date.
    const prefill = await prefillOf({
      date: 'next tuesday',
      recurrence: { freq: 'daily', untilDate: 'december' },
      startTime: '25:70',
      title: 'Thing',
    });
    expect(prefill.date).toBe('2026-08-22');
    expect(prefill.isAllDay).toBe(true);
    expect(prefill.recurrence).toEqual({ freq: 'daily' });
  });

  it('drops placeholder strings the model invents', async () => {
    // Observed on device: "unknown" written into a location the phrase
    // never mentioned.
    const prefill = await prefillOf({ location: 'unknown', startTime: '09:00', title: 'Standup' });
    expect(prefill.location).toBeUndefined();
    expect(
      await parseQuickAdd(fakeModel({ location: 'N/A', title: 'none' }), {
        phrase: 'x',
        ...CONTEXT,
      }),
    ).toMatchObject({ kind: 'rejected' });
  });

  it('drops a repeat that only happens once', async () => {
    // Also observed: "next Tuesday" came back as a weekly repeat, count 1.
    const prefill = await prefillOf({
      recurrence: { count: 1, freq: 'weekly' },
      startTime: '13:00',
      title: 'Lunch',
    });
    expect(prefill.recurrence).toBeUndefined();
  });

  it('rejects a date-shaped string that is not a real date', async () => {
    // '2026-02-30' passes a regex but is not a day; it used to reach Google
    // as UNTIL=20260230T235959Z and come back a 400.
    const prefill = await prefillOf({
      recurrence: { freq: 'weekly', untilDate: '2026-02-30' },
      startTime: '09:00',
      title: 'Standup',
    });
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
    const prefill = await prefillOf({
      recurrence: { freq: 'fortnightly' as never },
      startTime: '09:00',
      title: 'Standup',
    });
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
      parseQuickAdd(fakeModel({ title: 'x' }, { available: false }), {
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
