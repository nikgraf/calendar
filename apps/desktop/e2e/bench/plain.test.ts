import { describe, expect, it } from 'vite-plus/test';
import type { BenchDraft } from './check.ts';
import { buildPlainPrompt, buildPlainRefinePrompt, plainResult, plainState } from './plain.ts';
import { claudeSpec } from './providers.ts';

// A Tuesday; the tests only ever compare against it.
const TODAY = '2026-11-10';

const first = (answer: unknown) => plainResult(answer, { draft: undefined, referenceDate: TODAY });

const draftOf = (
  prefill: Partial<Extract<BenchDraft['item'], { kind: 'event' }>['prefill']>,
  rest: Partial<BenchDraft> = {},
): BenchDraft => ({
  choices: [],
  guests: [],
  item: {
    kind: 'event',
    prefill: {
      date: TODAY,
      endTime: '20:00',
      isAllDay: false,
      startTime: '19:00',
      title: 'Dinner',
      ...prefill,
    },
  },
  ...rest,
});

describe('plainResult, a first phrase', () => {
  it('fills what a form would: today, all day without a start, an hour without an end', () => {
    expect(first({ kind: 'event', title: 'Offsite', understood: true })).toEqual({
      kind: 'parsed',
      prefill: {
        date: TODAY,
        endTime: '01:00',
        isAllDay: true,
        startTime: '00:00',
        title: 'Offsite',
      },
    });
    expect(
      first({
        date: '2026-11-13',
        kind: 'event',
        location: ' Blue Door ',
        startTime: '9:30',
        timeAssumed: true,
        title: 'Breakfast',
        understood: true,
      }),
    ).toEqual({
      kind: 'parsed',
      prefill: {
        assumedTime: true,
        date: '2026-11-13',
        endTime: '10:30',
        isAllDay: false,
        location: 'Blue Door',
        startTime: '09:30',
        title: 'Breakfast',
      },
    });
  });

  it('keeps a stated end, and drops one that is not after the start or not a time', () => {
    const answer = { kind: 'event', startTime: '14:00', title: 'Review', understood: true };
    expect(first({ ...answer, endTime: '15:30' })).toMatchObject({ prefill: { endTime: '15:30' } });
    expect(first({ ...answer, endTime: '13:00' })).toMatchObject({ prefill: { endTime: '15:00' } });
    expect(first({ ...answer, endTime: '25:00' })).toMatchObject({ prefill: { endTime: '15:00' } });
  });

  it('takes a date that is none as today', () => {
    const answer = { kind: 'event', title: 'Review', understood: true };
    expect(first({ ...answer, date: '2026-02-30' })).toMatchObject({ prefill: { date: TODAY } });
    expect(first({ ...answer, date: 'Friday' })).toMatchObject({ prefill: { date: TODAY } });
  });

  it('makes a to-do with its time and its note', () => {
    expect(
      first({
        kind: 'task',
        notes: 'the blue folder',
        startTime: '17:00',
        title: 'Call the bank',
        understood: true,
      }),
    ).toEqual({
      kind: 'task',
      notes: { kind: 'add', text: 'the blue folder' },
      prefill: { date: TODAY, time: '17:00', title: 'Call the bank' },
    });
  });

  it('refuses what was not understood, and an answer without a title', () => {
    expect(first({ kind: 'event', title: 'x', understood: false }).kind).toBe('rejected');
    expect(first({ kind: 'event', title: '  ', understood: true }).kind).toBe('rejected');
    expect(first('nonsense').kind).toBe('rejected');
  });

  it('reads a repeat: one weekday of a weekly rule is the date, several are listed', () => {
    const answer = { kind: 'event', title: 'Standup', understood: true };
    expect(first({ ...answer, repeat: { byDay: ['TH'], freq: 'weekly' } })).toMatchObject({
      prefill: { date: '2026-11-12', recurrence: { freq: 'weekly' } },
    });
    expect(
      first({ ...answer, repeat: { byDay: ['mo', 'WE'], freq: 'weekly', interval: 2 } }),
    ).toMatchObject({
      prefill: {
        date: '2026-11-11',
        recurrence: {
          byDay: [{ weekday: 'MO' }, { weekday: 'WE' }],
          freq: 'weekly',
          interval: 2,
        },
      },
    });
    expect(
      first({ ...answer, repeat: { byDay: ['-1FR'], count: 5, freq: 'monthly', interval: 1 } }),
    ).toMatchObject({
      prefill: {
        recurrence: { byDay: [{ ordinal: -1, weekday: 'FR' }], count: 5, freq: 'monthly' },
      },
    });
    expect(first({ ...answer, repeat: { freq: 'sometimes' } })).not.toHaveProperty(
      'prefill.recurrence',
    );
  });

  it('passes on who is invited, the notifications and the note', () => {
    expect(
      first({
        invite: ['Ben', ' '],
        kind: 'event',
        notes: 'bring the contract',
        reminders: [60, 10, -5, 2.5],
        title: 'Review',
        understood: true,
        uninvite: [],
      }),
    ).toMatchObject({
      invite: ['Ben'],
      notes: { kind: 'add', text: 'bring the contract' },
      reminders: { add: [60, 10], clear: false, remove: [] },
    });
  });
});

describe('plainResult, a change to the draft', () => {
  const draft = draftOf({ location: 'Blue Door' }, { notes: 'window table', reminders: [30] });
  const kept = {
    date: TODAY,
    endTime: '20:00',
    kind: 'event',
    location: 'Blue Door',
    notes: 'window table',
    reminders: [30],
    startTime: '19:00',
    title: 'Dinner',
    understood: true,
  };
  const change = (answer: unknown) => plainResult(answer, { draft, referenceDate: '2026-11-01' });

  it('changes nothing when the answer is the draft', () => {
    expect(change(kept)).toEqual({
      kind: 'parsed',
      prefill: {
        date: TODAY,
        endTime: '20:00',
        isAllDay: false,
        location: 'Blue Door',
        startTime: '19:00',
        title: 'Dinner',
      },
    });
  });

  it('keeps the day of the draft when the answer names none', () => {
    const { date: _date, ...rest } = kept;
    expect(change(rest)).toMatchObject({ prefill: { date: TODAY } });
  });

  it('removes what the answer leaves out', () => {
    const { location: _location, notes: _notes, reminders: _reminders, ...rest } = kept;
    const result = change(rest);
    expect(result).toMatchObject({
      notes: { kind: 'clear' },
      reminders: { add: [], clear: true, remove: [] },
    });
    expect(result).not.toHaveProperty('prefill.location');
  });

  it('replaces the note and the notifications with the ones in the answer', () => {
    expect(change({ ...kept, notes: 'by the door', reminders: [30, 60] })).toMatchObject({
      notes: { kind: 'replace', text: 'by the door' },
      reminders: { add: [30, 60], clear: true, remove: [] },
    });
  });
});

describe('the plain prompts', () => {
  it('give the phrase, today and the conventions', () => {
    const prompt = buildPlainPrompt({
      phrase: 'Dinner Friday',
      referenceDate: TODAY,
      timeZone: 'Europe/Vienna',
    });
    expect(prompt).toContain('Phrase: Dinner Friday');
    expect(prompt).toContain(`Tue ${TODAY} (today)`);
    expect(prompt).toContain('Fri 2026-11-13');
  });

  it('give a change the draft in the terms of the answer, and what was said before', () => {
    const state = plainState(
      draftOf(
        {
          isAllDay: true,
          recurrence: { byDay: [{ ordinal: 2, weekday: 'TU' }], freq: 'monthly' },
        },
        { guests: [{ email: 'ben@example.com' }], notes: 'window table', reminders: [30] },
      ),
    );
    expect(state).toEqual({
      date: TODAY,
      guests: ['ben@example.com'],
      kind: 'event',
      notes: 'window table',
      reminders: [30],
      repeat: { byDay: ['2TU'], freq: 'monthly' },
      title: 'Dinner',
    });
    const prompt = buildPlainRefinePrompt({
      earlier: ['Dinner tonight'],
      referenceDate: TODAY,
      state: state!,
      timeZone: 'Europe/Vienna',
      utterance: 'make it 8',
    });
    expect(prompt).toContain(`Draft: ${JSON.stringify(state)}`);
    expect(prompt).toContain('Said before: ["Dinner tonight"]');
    expect(prompt).toContain('Now: make it 8');
  });

  it('reads a to-do as the event it would be, and says it is one', () => {
    const state = plainState({
      choices: [],
      guests: [],
      item: { kind: 'task', prefill: { date: TODAY, time: '17:00', title: 'Call the bank' } },
    });
    expect(state).toEqual({
      date: TODAY,
      endTime: '18:00',
      kind: 'task',
      startTime: '17:00',
      title: 'Call the bank',
    });
  });
});

describe('claudeSpec', () => {
  it('reads the model and its effort', () => {
    expect(claudeSpec('claude-haiku-5-5@low')).toEqual({
      effort: 'low',
      model: 'claude-haiku-5-5',
    });
    expect(claudeSpec(' claude-opus-5-5 ')).toEqual({ effort: 'medium', model: 'claude-opus-5-5' });
    expect(claudeSpec('claude-opus-5-5@loud')).toEqual({
      effort: 'medium',
      model: 'claude-opus-5-5',
    });
  });
});
