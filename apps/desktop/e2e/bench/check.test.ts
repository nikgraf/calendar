import type { QuickAddResult } from '@calendar/ai';
import { Contact } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { applyResult, type BenchDraft, check, fieldsOf, fold, wordErrorRate } from './check.ts';

// 2026-08-22 is a Saturday; 2026-08-28 the Friday after.
const TODAY = '2026-08-22';
const FRIDAY = '2026-08-28';

type EventPrefill = Extract<BenchDraft['item'], { kind: 'event' }>['prefill'];

const event = (
  prefill: Partial<EventPrefill> = {},
  rest: Partial<BenchDraft> = {},
): BenchDraft => ({
  choices: [],
  guests: [],
  item: {
    kind: 'event',
    prefill: {
      date: FRIDAY,
      endTime: '20:00',
      isAllDay: false,
      startTime: '19:00',
      title: 'Dinner with Teo',
      ...prefill,
    },
  },
  ...rest,
});

const task = (prefill: { date?: string; time?: string; title?: string } = {}): BenchDraft => ({
  choices: [],
  guests: [],
  item: {
    kind: 'task',
    prefill: { date: FRIDAY, title: 'Call the bank', ...prefill },
  },
});

const drafted = (draft: BenchDraft) => ({ draft, kind: 'draft' as const });

const contact = (displayName: string, email: string): Contact =>
  new Contact({ displayName, email, id: `device:${email}`, source: 'device' });

const BOOK = [
  contact('Tom Baker', 'tom.baker@example.com'),
  contact('Anna Lee', 'anna.lee@example.com'),
  contact('Anna Berger', 'anna.berger@example.com'),
];

describe('check', () => {
  it('passes a draft that is where a person would put it, and lists what it checked', () => {
    const result = check(
      {
        assumedTime: false,
        endTime: '20:00',
        guests: {},
        isAllDay: false,
        kind: 'event',
        location: null,
        repeat: null,
        startTime: '19:00',
        title: 'dinner with teo',
        weekday: 5,
      },
      drafted(event()),
      undefined,
      TODAY,
    );
    expect(result.failed).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.checked).toEqual([
      'kind',
      'title',
      'date',
      'time',
      'allDay',
      'location',
      'repeat',
      'guests',
    ]);
  });

  it('compares titles folded, whole or by a part', () => {
    const draft = drafted(event({ title: 'Fußball-Training' }));
    expect(check({ title: 'fussball-training' }, draft, undefined, TODAY).failed).toEqual([]);
    expect(check({ titleIncludes: 'FUSSBALL' }, draft, undefined, TODAY).failed).toEqual([]);
    expect(check({ title: 'Fußball' }, draft, undefined, TODAY)).toMatchObject({
      failed: ['title'],
      notes: ['title=Fußball-Training'],
    });
    // Several titles a person would accept.
    expect(
      check({ title: ['fussball', 'fussball-training'] }, draft, undefined, TODAY).failed,
    ).toEqual([]);
    expect(check({ title: ['fussball', 'training'] }, draft, undefined, TODAY).failed).toEqual([
      'title',
    ]);
  });

  it('reads the date as a weekday or an offset from today', () => {
    const draft = drafted(event());
    expect(check({ dayOffset: 6, weekday: 5 }, draft, undefined, TODAY).failed).toEqual([]);
    expect(check({ weekday: 4 }, draft, undefined, TODAY).notes).toEqual([
      'weekday=5 (2026-08-28)',
    ]);
    expect(check({ dayOffset: 1 }, draft, undefined, TODAY).notes).toEqual(['day=2026-08-28']);
  });

  it('holds times, all-day and assumed times apart', () => {
    const allDay = drafted(event({ endTime: '01:00', isAllDay: true, startTime: '00:00' }));
    expect(check({ isAllDay: false, startTime: '19:00' }, allDay, undefined, TODAY)).toMatchObject({
      failed: ['time', 'allDay'],
      notes: ['start=-', 'allDay=true'],
    });
    const assumed = drafted(event({ assumedTime: true }));
    expect(
      check({ assumedTime: true, endTime: '20:00' }, assumed, undefined, TODAY).failed,
    ).toEqual([]);
    expect(check({ assumedTime: false }, assumed, undefined, TODAY).notes).toEqual([
      'assumed=true',
    ]);
  });

  it('a to-do has its own time and no end', () => {
    const timed = drafted(task({ time: '09:30' }));
    expect(
      check({ isAllDay: false, kind: 'task', startTime: '09:30' }, timed, undefined, TODAY).failed,
    ).toEqual([]);
    expect(check({ endTime: '10:30' }, timed, undefined, TODAY).notes).toEqual(['end=-']);
    expect(
      check({ isAllDay: true, kind: 'event' }, drafted(task()), undefined, TODAY),
    ).toMatchObject({
      failed: ['kind'],
      notes: ['kind=task'],
    });
  });

  it('a location must contain the words, or be absent', () => {
    const placed = drafted(event({ location: 'Café Prückel, Wien' }));
    expect(check({ location: 'cafe pruckel' }, placed, undefined, TODAY).failed).toEqual([]);
    expect(check({ location: null }, placed, undefined, TODAY).notes).toEqual([
      'location=Café Prückel, Wien',
    ]);
    expect(check({ location: 'loos bar' }, drafted(event()), undefined, TODAY).notes).toEqual([
      'location=-',
    ]);
  });

  it('a repeat matches by frequency, interval, count and the month it ends in', () => {
    const fortnightly = drafted(
      event({ recurrence: { freq: 'weekly', interval: 2, untilDate: '2027-03-01' } }),
    );
    expect(
      check(
        { repeat: { freq: 'weekly', interval: 2, untilMonth: 3 } },
        fortnightly,
        undefined,
        TODAY,
      ).failed,
    ).toEqual([]);
    // An interval left out reads as 1.
    expect(check({ repeat: { freq: 'weekly' } }, fortnightly, undefined, TODAY).notes).toEqual([
      'repeat=weekly every 2 until 2027-03-01',
    ]);
    expect(check({ repeat: null }, fortnightly, undefined, TODAY).failed).toEqual(['repeat']);
    // The weekdays of a weekly rule, as a set; a rule without them fails an expectation that names them.
    const weekdays = drafted(
      event({
        recurrence: {
          byDay: [
            { weekday: 'TU' },
            { weekday: 'MO' },
            { weekday: 'WE' },
            { weekday: 'TH' },
            { weekday: 'FR' },
          ],
          freq: 'weekly',
        },
      }),
    );
    expect(
      check(
        { repeat: { byDay: ['MO', 'TU', 'WE', 'TH', 'FR'], freq: 'weekly' } },
        weekdays,
        undefined,
        TODAY,
      ).failed,
    ).toEqual([]);
    expect(
      check({ repeat: { byDay: ['MO'], freq: 'weekly' } }, weekdays, undefined, TODAY).notes,
    ).toEqual(['repeat=weekly on TU,MO,WE,TH,FR']);
    expect(
      check(
        { repeat: { byDay: ['MO', 'TU', 'WE', 'TH', 'FR'], freq: 'weekly' } },
        drafted(event({ recurrence: { freq: 'weekly' } })),
        undefined,
        TODAY,
      ).notes,
    ).toEqual(['repeat=weekly']);
    expect(check({ repeat: { freq: 'daily' } }, drafted(event()), undefined, TODAY).notes).toEqual([
      'repeat=-',
    ]);
  });

  it('guests are the list and the open choices, as sets; absent means none', () => {
    const invited = drafted(
      event(
        {},
        {
          choices: [{ contacts: [], name: 'Anna' }],
          guests: [{ email: 'Tom.Baker@example.com' }, { email: 'jo@example.com' }],
        },
      ),
    );
    expect(
      check(
        { guests: { choices: ['anna'], emails: ['jo@example.com', 'tom.baker@example.com'] } },
        invited,
        undefined,
        TODAY,
      ).failed,
    ).toEqual([]);
    expect(
      check(
        { guests: { emails: ['jo@example.com', 'tom.baker@example.com'] } },
        invited,
        undefined,
        TODAY,
      ),
    ).toMatchObject({
      failed: ['guests'],
      notes: ['guests=tom.baker@example.com,jo@example.com; choices=Anna'],
    });
    expect(check({ guests: {} }, drafted(event()), undefined, TODAY).failed).toEqual([]);
  });

  it('notes and notifications: nothing fills them yet, so a case that names them fails', () => {
    const bare = drafted(event());
    expect(
      check({ notes: 'bring the contract', reminders: [30] }, bare, undefined, TODAY),
    ).toMatchObject({
      failed: ['notes', 'reminders'],
      notes: ['notes=-', 'reminders=-'],
    });
    const filled = drafted(event({}, { notes: 'Bring the contract.', reminders: [60, 30] }));
    expect(
      check({ notes: 'bring the contract', reminders: [30, 60] }, filled, undefined, TODAY).failed,
    ).toEqual([]);
  });

  it('a rejection fails every field the expectation named, unless it was expected', () => {
    const rejected = { kind: 'rejected' as const, reason: 'No event title was recognised.' };
    expect(check({ title: 'dinner', weekday: 5 }, rejected, undefined, TODAY)).toEqual({
      checked: ['title', 'date'],
      failed: ['title', 'date'],
      notes: ['rejected: No event title was recognised.'],
    });
    expect(check({ rejected: true }, rejected, undefined, TODAY).failed).toEqual([]);
    expect(check({ rejected: true }, drafted(event()), undefined, TODAY)).toMatchObject({
      failed: ['rejected'],
      notes: ['accepted, a rejection was expected'],
    });
  });

  it('a later turn must leave every part it was not about as it was', () => {
    const before = event();
    const moved = drafted(event({ endTime: '21:00', startTime: '20:00', title: 'Team dinner' }));
    expect(check({ endTime: '21:00', startTime: '20:00' }, moved, before, TODAY)).toMatchObject({
      failed: ['unchanged'],
      notes: ['changed title: team dinner'],
    });
    expect(
      check({ endTime: '21:00', startTime: '20:00', title: 'team dinner' }, moved, before, TODAY),
    ).toMatchObject({ checked: ['title', 'time', 'unchanged'], failed: [] });
    // Times and all-day-ness are one part: an all-day expectation covers the times.
    const wholeDay = drafted(event({ endTime: '01:00', isAllDay: true, startTime: '00:00' }));
    expect(check({ isAllDay: true }, wholeDay, before, TODAY).failed).toEqual([]);
    // The first turn has nothing to be held to.
    expect(check({ title: 'team dinner' }, moved, undefined, TODAY).checked).toEqual(['title']);
  });

  it('a rejected later turn fails the unchanged rule too', () => {
    const result = check(
      { startTime: '20:00' },
      { kind: 'rejected', reason: 'That would end after midnight.' },
      event(),
      TODAY,
    );
    expect(result.failed).toEqual(['time', 'unchanged']);
  });
});

describe('fieldsOf', () => {
  it('names the fields an expectation scores', () => {
    expect(
      fieldsOf({
        dayOffset: 1,
        endTime: '10:00',
        guests: {},
        isAllDay: false,
        kind: 'event',
        location: 'x',
        notes: 'y',
        reminders: [5],
        repeat: null,
        title: 'z',
      }),
    ).toEqual([
      'kind',
      'title',
      'date',
      'time',
      'allDay',
      'location',
      'repeat',
      'guests',
      'notes',
      'reminders',
    ]);
    expect(fieldsOf({ rejected: true, title: 'ignored' })).toEqual(['rejected']);
  });
});

const parsed = (
  prefill: Partial<EventPrefill>,
  whom: { invite?: ReadonlyArray<string>; uninvite?: ReadonlyArray<string> } = {},
): QuickAddResult => ({
  ...whom,
  kind: 'parsed',
  prefill: {
    date: FRIDAY,
    endTime: '20:00',
    isAllDay: false,
    startTime: '19:00',
    title: 'Dinner',
    ...prefill,
  },
});

describe('applyResult', () => {
  it('looks the invited names up in the address book: one match joins, several are a choice', async () => {
    const outcome = await applyResult(
      undefined,
      parsed({}, { invite: ['Tom', 'Anna', 'jo@example.com'] }),
      BOOK,
    );
    expect(outcome.kind).toBe('draft');
    if (outcome.kind !== 'draft') {
      return;
    }
    expect(outcome.draft.guests).toEqual([
      { displayName: 'Tom Baker', email: 'tom.baker@example.com' },
      { email: 'jo@example.com' },
    ]);
    expect(outcome.draft.choices.map((choice) => choice.name)).toEqual(['Anna']);
    expect(outcome.draft.choices[0]?.contacts.map((person) => person.displayName)).toEqual([
      'Anna Berger',
      'Anna Lee',
    ]);
  });

  it('a later turn takes guests off and keeps the rest', async () => {
    const previous = event(
      {},
      { guests: [{ email: 'tom.baker@example.com' }, { email: 'jo@example.com' }] },
    );
    const outcome = await applyResult(
      previous,
      parsed({ startTime: '20:00' }, { uninvite: ['Tom'] }),
      BOOK,
    );
    expect(outcome.kind === 'draft' && outcome.draft.guests).toEqual([{ email: 'jo@example.com' }]);
    expect(
      outcome.kind === 'draft' &&
        outcome.draft.item.kind === 'event' &&
        outcome.draft.item.prefill.startTime,
    ).toBe('20:00');
  });

  it('a to-do stays a to-do through a change, and its words about people stay its title’s', async () => {
    const outcome = await applyResult(
      task(),
      parsed({ startTime: '09:00', title: 'Call the bank' }, { invite: ['Tom'] }),
      BOOK,
    );
    expect(outcome.kind === 'draft' && outcome.draft.item).toEqual({
      kind: 'task',
      prefill: { date: FRIDAY, time: '09:00', title: 'Call the bank' },
    });
    expect(outcome.kind === 'draft' && outcome.draft.guests).toEqual([]);
  });

  it('passes a to-do and a rejection through, and carries notes and notifications along', async () => {
    expect(
      await applyResult(
        undefined,
        { kind: 'task', prefill: { date: FRIDAY, title: 'Call' } },
        BOOK,
      ),
    ).toEqual({
      draft: {
        choices: [],
        guests: [],
        item: { kind: 'task', prefill: { date: FRIDAY, title: 'Call' } },
      },
      kind: 'draft',
    });
    expect(await applyResult(undefined, { kind: 'rejected', reason: 'nope' }, BOOK)).toEqual({
      kind: 'rejected',
      reason: 'nope',
    });
    const carried = await applyResult(event({}, { notes: 'x', reminders: [10] }), parsed({}), BOOK);
    expect(carried.kind === 'draft' && carried.draft).toMatchObject({
      notes: 'x',
      reminders: [10],
    });
  });
});

describe('wordErrorRate', () => {
  it('is 0 for the same words whatever the case and punctuation', () => {
    expect(wordErrorRate('Dinner with Teo next Friday.', 'dinner with teo next friday')).toBe(0);
    expect(wordErrorRate('Kaffee im Café Prückel', 'kaffee im cafe pruckel')).toBe(0);
  });

  it('counts edits over the words said', () => {
    expect(wordErrorRate('dinner with teo next friday', 'dinner with theo next friday')).toBe(0.2);
    expect(wordErrorRate('invite jo@example.com', 'invite jo at example dot com')).toBe(2.5);
    expect(wordErrorRate('make it 8', '')).toBe(1);
  });

  it('keeps an address whole', () => {
    expect(fold('Tom.Baker@Example.com')).toBe('tom.baker@example.com');
    expect(wordErrorRate('invite tom.baker@example.com', 'invite tom.baker@example.com.')).toBe(0);
  });
});
