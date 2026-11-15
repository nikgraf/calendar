import type { QuickAddResult } from '@calendar/ai';
import { Contact } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import {
  applyResult,
  type BenchDraft,
  check,
  checkWithoutDraft,
  fieldsOf,
  fold,
  wordErrorRate,
} from './check.ts';

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

/** A monthly repeat on these days, as an expectation. */
const monthly = (byDay: ReadonlyArray<string>) => ({
  repeat: { byDay, freq: 'monthly' as const },
});

/** The fixture event on another day. */
const on = (date: string) => drafted(event({ date }));

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
      'unsaid',
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

  it('reads a date said by its number as the next such day', () => {
    // TODAY is the 22nd of August, the draft's day the 28th.
    const draft = drafted(event());
    expect(check({ dayOfMonth: 28, month: 8 }, draft, undefined, TODAY).failed).toEqual([]);
    expect(check({ dayOfMonth: 27 }, draft, undefined, TODAY).notes).toEqual(['day=2026-08-28']);
    expect(check({ month: 9 }, draft, undefined, TODAY).notes).toEqual(['day=2026-08-28']);
    // The right day of the right month, a year back: it has passed.
    const passed = drafted(event({ date: '2025-08-28' }));
    expect(check({ dayOfMonth: 28, month: 8 }, passed, undefined, TODAY)).toMatchObject({
      failed: ['date'],
      notes: ['day=2025-08-28 (passed)'],
    });
    // Today itself is the next such day.
    expect(
      check({ dayOfMonth: 22 }, drafted(event({ date: TODAY })), undefined, TODAY).failed,
    ).toEqual([]);
  });

  it('takes the next such day only, not the same day a year on', () => {
    // With its month, the one next such day.
    expect(check({ dayOfMonth: 5, month: 12 }, on('2026-12-05'), undefined, TODAY).failed).toEqual(
      [],
    );
    expect(check({ dayOfMonth: 5, month: 12 }, on('2027-12-05'), undefined, TODAY)).toMatchObject({
      failed: ['date'],
      notes: ['day=2027-12-05 (not the next)'],
    });
    // A month that has passed this year is next year's.
    expect(check({ dayOfMonth: 3, month: 2 }, on('2027-02-03'), undefined, TODAY).failed).toEqual(
      [],
    );
    // A day of the month alone, in a first phrase: the next such day and no other.
    expect(check({ dayOfMonth: 23 }, on('2026-08-23'), undefined, TODAY).failed).toEqual([]);
    expect(check({ dayOfMonth: 23 }, on('2026-09-23'), undefined, TODAY).notes).toEqual([
      'day=2026-09-23 (not the next)',
    ]);
    // The 14th has passed in August: September's.
    expect(check({ dayOfMonth: 14 }, on('2026-09-14'), undefined, TODAY).failed).toEqual([]);
    expect(check({ dayOfMonth: 14 }, on('2026-10-14'), undefined, TODAY).failed).toContain('date');
    // A 31st skips the months that have none.
    expect(check({ dayOfMonth: 31 }, on('2026-08-31'), undefined, TODAY).failed).toEqual([]);
    expect(check({ dayOfMonth: 31 }, on('2026-10-31'), undefined, TODAY).failed).toContain('date');
  });

  it('lets a later turn keep the month of the draft it changes', () => {
    // "The 23rd instead", said to a draft in October: October's, or the next from today.
    const october = event({ date: '2026-10-12' });
    const moved = (date: string) =>
      check({ dayOfMonth: 23 }, drafted(event({ date })), october, TODAY).failed;
    expect(moved('2026-10-23')).toEqual([]);
    expect(moved('2026-08-23')).toEqual([]);
    expect(moved('2026-09-23')).toEqual(['date']);
    expect(moved('2026-11-23')).toEqual(['date']);
    // A draft in a month without that day adds nothing: the next 31st from today only.
    const september = event({ date: '2026-09-10' });
    expect(
      check({ dayOfMonth: 31 }, drafted(event({ date: '2026-10-31' })), september, TODAY).failed,
    ).toEqual(['date']);
    expect(
      check({ dayOfMonth: 31 }, drafted(event({ date: '2026-08-31' })), september, TODAY).failed,
    ).toEqual([]);
    // With its month said, the draft's month is nothing to keep.
    expect(
      check({ dayOfMonth: 23, month: 9 }, drafted(event({ date: '2026-10-23' })), october, TODAY)
        .failed,
    ).toEqual(['date']);
  });

  it('counts the days an event runs past its first', () => {
    const overnight = event({ endDate: '2026-08-29', endTime: '02:00', startTime: '22:00' });
    expect(
      check({ endTime: '02:00', spanDays: 1 }, drafted(overnight), undefined, TODAY).failed,
    ).toEqual([]);
    expect(check({ spanDays: 0 }, drafted(overnight), undefined, TODAY)).toMatchObject({
      failed: ['time'],
      notes: ['span=1d'],
    });
    expect(check({ spanDays: 1 }, drafted(event()), undefined, TODAY).notes).toEqual(['span=0d']);
    // A later turn that moves the day keeps the span: the time reads as it did.
    const moved = drafted(
      event({ date: '2026-08-30', endDate: '2026-08-31', endTime: '02:00', startTime: '22:00' }),
    );
    expect(check({ dayOffset: 8 }, moved, overnight, TODAY).failed).toEqual([]);
    // One that drops the second day changed the time.
    const oneDay = drafted(event({ endTime: '02:00', startTime: '22:00' }));
    expect(check({ title: 'dinner with teo' }, oneDay, overnight, TODAY)).toMatchObject({
      failed: ['unchanged'],
      notes: ['changed time: 22:00-02:00'],
    });
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

  it('a location held whole must be the words and nothing else', () => {
    const placed = drafted(event({ location: 'Berlin, Vienna' }));
    expect(check({ location: 'vienna' }, placed, undefined, TODAY).failed).toEqual([]);
    expect(check({ locationIs: 'vienna' }, placed, undefined, TODAY).notes).toEqual([
      'location=Berlin, Vienna',
    ]);
    const moved = drafted(event({ location: 'Vienna' }));
    expect(check({ locationIs: 'vienna' }, moved, undefined, TODAY).failed).toEqual([]);
    expect(check({ locationIs: 'vienna' }, drafted(event()), undefined, TODAY).notes).toEqual([
      'location=-',
    ]);
    // It is about the location: the unchanged rule leaves that part alone.
    expect(check({ locationIs: 'vienna' }, moved, placed.draft, TODAY).failed).toEqual([]);
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

  it('a monthly rule’s weekday is held to its place in the month', () => {
    const lastFriday = drafted(
      event({ recurrence: { byDay: [{ ordinal: -1, weekday: 'FR' }], freq: 'monthly' } }),
    );
    expect(check(monthly(['-1FR']), lastFriday, undefined, TODAY).failed).toEqual([]);
    // The first Friday is another schedule, and so is a Friday without a place.
    expect(check(monthly(['1FR']), lastFriday, undefined, TODAY).notes).toEqual([
      'repeat=monthly on -1FR',
    ]);
    expect(check(monthly(['FR']), lastFriday, undefined, TODAY).failed).toEqual(['repeat']);
    expect(
      check(
        monthly(['-1FR']),
        drafted(event({ recurrence: { byDay: [{ weekday: 'FR' }], freq: 'monthly' } })),
        undefined,
        TODAY,
      ).failed,
    ).toEqual(['repeat']);
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
      checked: ['title', 'date', 'unsaid'],
      failed: ['title', 'date', 'unsaid'],
      notes: ['rejected: No event title was recognised.'],
    });
    expect(check({ rejected: true }, rejected, undefined, TODAY).failed).toEqual([]);
    expect(check({ rejected: true }, drafted(event()), undefined, TODAY)).toMatchObject({
      failed: ['rejected'],
      notes: ['accepted, a rejection was expected'],
    });
  });

  it('a later turn without a draft fails what it named, and neither rule', () => {
    expect(checkWithoutDraft({ startTime: '20:00', title: 'dinner' }, TODAY)).toEqual({
      checked: ['title', 'time'],
      failed: ['title', 'time'],
      notes: ['rejected: no draft'],
    });
    expect(checkWithoutDraft({ rejected: true }, TODAY).failed).toEqual([]);
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
    // The first turn has no draft before it: it is held to the unsaid rule instead.
    expect(check({ title: 'team dinner' }, moved, undefined, TODAY).checked).toEqual([
      'title',
      'unsaid',
    ]);
  });

  it('a first phrase must put nothing in the draft that was not said', () => {
    const invented: BenchDraft = {
      ...event({ location: 'nichts', recurrence: { freq: 'yearly' } }),
      choices: [{ contacts: [], name: 'Teo' }],
      notes: 'Dinner with Teo',
      reminders: [60],
    };
    expect(check({ title: 'dinner with teo' }, drafted(invented), undefined, TODAY)).toEqual({
      checked: ['title', 'unsaid'],
      failed: ['unsaid'],
      notes: [
        'unsaid guests: |teo',
        'unsaid location: nichts',
        'unsaid notes: dinner with teo',
        'unsaid reminders: 60',
        'unsaid repeat: yearly',
      ],
    });
    // A part the expectation names is its own to judge, right or wrong.
    expect(
      check(
        {
          guests: { choices: ['Teo'] },
          location: 'nichts',
          notes: 'teo',
          reminders: [60],
          repeat: { freq: 'yearly' },
        },
        drafted(invented),
        undefined,
        TODAY,
      ).failed,
    ).toEqual([]);
    // A to-do has no place, repeat or guests to invent, and a plain draft none either.
    expect(check({ kind: 'task' }, drafted(task()), undefined, TODAY).failed).toEqual([]);
    expect(check({ title: 'dinner with teo' }, drafted(event()), undefined, TODAY).failed).toEqual(
      [],
    );
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
    expect(fieldsOf({ dayOfMonth: 3, spanDays: 1 })).toEqual(['date', 'time']);
    expect(fieldsOf({ month: 3 })).toEqual(['date']);
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

  it('keeps a to-do’s alerts, from a first phrase and a later turn', async () => {
    const first = await applyResult(
      undefined,
      {
        kind: 'task',
        prefill: { date: FRIDAY, time: '09:00', title: 'Call the bank' },
        reminders: { add: [10], clear: false, remove: [] },
      },
      BOOK,
    );
    expect(first.kind === 'draft' && first.draft.reminders).toEqual([10]);
    const later = await applyResult(
      { ...task({ time: '09:00' }), reminders: [10] },
      parsedWith({ reminders: { add: [60], clear: false, remove: [] } }),
      BOOK,
    );
    expect(later.kind === 'draft' && later.draft.reminders).toEqual([10, 60]);
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

/** A parsed event with what the words said beside it. */
const parsedWith = (extras: Partial<Extract<QuickAddResult, { kind: 'parsed' }>>) => ({
  ...(parsed({}) as Extract<QuickAddResult, { kind: 'parsed' }>),
  ...extras,
});

describe('applyResult — notes and notifications', () => {
  it('adds a note to the notes and offsets to the notifications, as the thread does', async () => {
    const first = await applyResult(
      undefined,
      parsedWith({
        notes: { kind: 'add', text: 'bring the contract' },
        reminders: { add: [30], clear: false, remove: [] },
      }),
      BOOK,
    );
    expect(first.kind === 'draft' && first.draft).toMatchObject({
      notes: 'bring the contract',
      reminders: [30],
    });
    const next = await applyResult(
      event({}, { notes: 'bring the contract', reminders: [30] }),
      parsedWith({
        notes: { kind: 'add', text: 'and the slides' },
        reminders: { add: [60], clear: false, remove: [] },
      }),
      BOOK,
    );
    expect(next.kind === 'draft' && next.draft).toMatchObject({
      notes: 'bring the contract\nand the slides',
      reminders: [30, 60],
    });
    // A to-do takes the note, and the notifications as its alerts.
    const todo = await applyResult(
      task(),
      parsedWith({
        notes: { kind: 'add', text: 'ask about the fee' },
        reminders: { add: [10], clear: false, remove: [] },
      }),
      BOOK,
    );
    expect(todo.kind === 'draft' && todo.draft).toMatchObject({
      item: { kind: 'task' },
      notes: 'ask about the fee',
    });
    expect(todo.kind === 'draft' && todo.draft.reminders).toEqual([10]);
  });
});
