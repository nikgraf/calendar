import { EventReminders, ReminderOverride } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { cardLines, changedFields, draftChanges } from './draftChanges.ts';
import type { Draft, DraftExtras } from './draftThread.ts';
import type { QuickAddItem } from './quickAddItem.ts';
import { seedRepeatFields } from './repeatState.ts';

const lunch: QuickAddItem = {
  kind: 'event',
  prefill: {
    date: '2026-08-28',
    endTime: '14:00',
    isAllDay: false,
    startTime: '13:00',
    title: 'Lunch with Sarah',
  },
};
const earlier: QuickAddItem = {
  kind: 'event',
  prefill: { ...lunch.prefill, endTime: '13:30', startTime: '12:30' },
};
const call: QuickAddItem = {
  kind: 'task',
  prefill: { date: '2026-08-25', time: '09:30', title: 'Call the bank' },
};

const BLANK: DraftExtras = { attendees: [], description: '', reminders: undefined };
const draft = (item: QuickAddItem, extras?: Partial<DraftExtras>): Draft => ({
  ...(extras ? { extras: { ...BLANK, ...extras } } : {}),
  id: 'd1',
  item,
});
const sarah = { displayName: 'Sarah Keller', email: 'sarah@example.com' };
const tom = { displayName: 'Tom Brandt', email: 'tom.brandt@example.com' };
const popups = (...minutes: ReadonlyArray<number>) =>
  new EventReminders({
    overrides: minutes.map((offset) => new ReminderOverride({ method: 'popup', minutes: offset })),
    useDefault: false,
  });

describe('draftChanges', () => {
  it('finds nothing between a draft and itself', () => {
    expect(draftChanges(draft(lunch), draft(lunch))).toEqual([]);
    expect(draftChanges(draft(call), draft(call))).toEqual([]);
  });

  it('says what a field read and what it reads', () => {
    expect(draftChanges(draft(lunch), draft(earlier))).toEqual([
      { field: 'time', from: '13:00–14:00', to: '12:30–13:30' },
    ]);
    expect(
      draftChanges(
        draft(lunch),
        draft({
          kind: 'event',
          prefill: { ...lunch.prefill, date: '2026-08-27', title: 'Team lunch' },
        }),
      ),
    ).toEqual([
      { field: 'title', from: 'Lunch with Sarah', to: 'Team lunch' },
      { field: 'date', from: 'Fri, Aug 28', to: 'Thu, Aug 27' },
    ]);
  });

  it('lists every field of a draft a step made', () => {
    const made = draftChanges(
      undefined,
      draft(
        { kind: 'event', prefill: { ...lunch.prefill, location: 'Figlmüller' } },
        { attendees: [sarah] },
      ),
    );
    expect(made).toEqual([
      { field: 'title', from: undefined, to: 'Lunch with Sarah' },
      { field: 'date', from: undefined, to: 'Fri, Aug 28' },
      { field: 'time', from: undefined, to: '13:00–14:00' },
      { field: 'location', from: undefined, to: 'Figlmüller' },
      {
        added: ['Sarah Keller'],
        field: 'guests',
        from: undefined,
        removed: [],
        to: 'Sarah Keller',
      },
    ]);
    expect([...changedFields(made)]).toEqual(['title', 'date', 'time', 'location', 'guests']);
  });

  it('reads a place set and a place cleared', () => {
    const placed: QuickAddItem = {
      kind: 'event',
      prefill: { ...lunch.prefill, location: 'Figlmüller' },
    };
    expect(draftChanges(draft(lunch), draft(placed))).toEqual([
      { field: 'location', from: undefined, to: 'Figlmüller' },
    ]);
    expect(draftChanges(draft(placed), draft(lunch))).toEqual([
      { field: 'location', from: 'Figlmüller', to: undefined },
    ]);
  });

  it('compares a repeat rule by its values, not by how it was written', () => {
    const weekly = (recurrence: Record<string, unknown>): QuickAddItem =>
      ({ kind: 'event', prefill: { ...lunch.prefill, recurrence } }) as QuickAddItem;
    expect(
      draftChanges(
        draft(weekly({ freq: 'weekly', interval: 1 })),
        draft(weekly({ byDay: [], freq: 'weekly' })),
      ),
    ).toEqual([]);
    expect(draftChanges(draft(lunch), draft(weekly({ freq: 'weekly' })))).toEqual([
      { field: 'repeat', from: undefined, to: 'repeats weekly' },
    ]);
  });

  it('names the guests that joined and left, by address', () => {
    expect(
      draftChanges(draft(lunch, { attendees: [sarah] }), draft(lunch, { attendees: [sarah, tom] })),
    ).toEqual([
      {
        added: ['Tom Brandt'],
        field: 'guests',
        from: 'Sarah Keller',
        removed: [],
        to: 'Sarah Keller, Tom Brandt',
      },
    ]);
    expect(
      draftChanges(draft(lunch, { attendees: [sarah, tom] }), draft(lunch, { attendees: [tom] })),
    ).toEqual([
      {
        added: [],
        field: 'guests',
        from: 'Sarah Keller, Tom Brandt',
        removed: ['Sarah Keller'],
        to: 'Tom Brandt',
      },
    ]);
  });

  it('takes the same guests in another order, or another case, as no change', () => {
    expect(
      draftChanges(
        draft(lunch, { attendees: [sarah, tom] }),
        draft(lunch, { attendees: [{ email: 'TOM.Brandt@example.com ' }, sarah] }),
      ),
    ).toEqual([]);
  });

  it('reads the notes of the kind the draft is, and not their surrounding space', () => {
    expect(
      draftChanges(
        draft(lunch, { description: 'Bring the menu' }),
        draft(lunch, { description: 'Bring the menu\n' }),
      ),
    ).toEqual([]);
    expect(draftChanges(draft(lunch), draft(lunch, { description: 'Bring the menu' }))).toEqual([
      { field: 'notes', from: undefined, to: 'Bring the menu' },
    ]);
    expect(
      draftChanges(draft(call, { taskNotes: 'IBAN' }), draft(call, { taskNotes: '' })),
    ).toEqual([{ field: 'notes', from: 'IBAN', to: undefined }]);
  });

  it('takes untouched notifications and the calendar default as the same', () => {
    expect(
      draftChanges(
        draft(lunch),
        draft(lunch, { reminders: new EventReminders({ overrides: [], useDefault: true }) }),
      ),
    ).toEqual([]);
  });

  it('reads notifications in their stored form', () => {
    expect(
      draftChanges(
        draft(lunch, { reminders: popups(30, 10) }),
        draft(lunch, { reminders: popups(10, 30, 30) }),
      ),
    ).toEqual([]);
    expect(draftChanges(draft(lunch), draft(lunch, { reminders: popups(60) }))).toEqual([
      { field: 'reminders', from: 'Calendar default', to: '1 hour before' },
    ]);
    expect(
      draftChanges(draft(lunch, { reminders: popups(60) }), draft(lunch, { reminders: popups() })),
    ).toEqual([{ field: 'reminders', from: '1 hour before', to: 'None' }]);
  });

  it('names a picked calendar or list, and takes a draft the form never held as no pick', () => {
    const names = { calendar: (key: string) => (key === 'a:work' ? 'Work' : 'Personal') };
    expect(
      draftChanges(
        draft(lunch, { calendarKey: 'a:personal' }),
        draft(lunch, { calendarKey: 'a:work' }),
        names,
      ),
    ).toEqual([{ field: 'calendar', from: 'Personal', to: 'Work' }]);
    expect(draftChanges(draft(lunch), draft(lunch, { calendarKey: 'a:work' }), names)).toEqual([]);
    expect(
      draftChanges(draft(call, { listKey: 'a:errands' }), draft(call, { listKey: 'a:home' })),
    ).toEqual([{ field: 'list', from: 'a:errands', to: 'a:home' }]);
  });

  it('says a to-do lost its day, and what a reminder holds beyond one', () => {
    expect(draftChanges(draft(call), draft(call, { undated: true }))).toEqual([
      { field: 'date', from: 'Tue, Aug 25', to: 'No due date' },
    ]);
    const fields = { alarms: [], repeat: seedRepeatFields(undefined), url: '' };
    expect(
      draftChanges(
        draft(call, { reminder: fields }),
        draft(call, {
          reminder: { ...fields, alarms: [15], priority: 'high', url: 'https://example.com' },
        }),
      ),
    ).toEqual([
      { field: 'priority', from: 'None', to: 'High' },
      { field: 'alert', from: 'None', to: '15 minutes before' },
      { field: 'url', from: undefined, to: 'https://example.com' },
    ]);
  });

  it('says a draft became the other kind', () => {
    expect(draftChanges(draft(lunch), draft(call))[0]).toEqual({
      field: 'kind',
      from: 'Event',
      to: 'To-do',
    });
  });

  it('reads a day the form holds half typed as typed, without throwing', () => {
    const halfTyped: QuickAddItem = { kind: 'event', prefill: { ...lunch.prefill, date: '' } };
    expect(draftChanges(draft(lunch), draft(halfTyped))).toEqual([
      { field: 'date', from: 'Fri, Aug 28', to: '' },
    ]);
    expect(draftChanges(draft(halfTyped), draft(halfTyped))).toEqual([]);
  });
});

describe('cardLines', () => {
  it('lists the day and the hours, and beyond them only what there is', () => {
    expect(cardLines(draft(lunch))).toEqual([
      { changed: false, field: 'date', text: 'Fri, Aug 28' },
      { changed: false, field: 'time', text: '13:00–14:00' },
    ]);
    expect(cardLines(draft(call)).map((line) => line.text)).toEqual(['Tue, Aug 25', '09:30']);
    // A to-do without a time has no line for one.
    expect(
      cardLines(draft({ kind: 'task', prefill: { date: '2026-08-25', title: 'Call' } })).map(
        (line) => line.field,
      ),
    ).toEqual(['date']);
  });

  it('marks what the step changed, with what it read before', () => {
    const before = draft(lunch, { attendees: [sarah] });
    const after = draft(
      { kind: 'event', prefill: { ...earlier.prefill, location: 'Figlmüller' } },
      { attendees: [sarah, tom], description: 'Bring the menu', reminders: popups(60) },
    );
    expect(cardLines(after, draftChanges(before, after))).toEqual([
      { changed: false, field: 'date', text: 'Fri, Aug 28' },
      { changed: true, field: 'time', text: '12:30–13:30', was: '13:00–14:00' },
      { changed: true, field: 'location', text: 'Figlmüller' },
      {
        added: ['Tom Brandt'],
        changed: true,
        field: 'guests',
        names: ['Sarah Keller', 'Tom Brandt'],
        text: 'Sarah Keller, Tom Brandt',
        was: 'Sarah Keller',
      },
      { changed: true, field: 'reminders', text: '1 hour before', was: 'Calendar default' },
      { changed: true, field: 'notes', text: 'Bring the menu' },
    ]);
  });

  it('says what a step took away, which an unchanged card leaves out', () => {
    const placed = draft(
      { kind: 'event', prefill: { ...lunch.prefill, location: 'Figlmüller' } },
      { attendees: [sarah] },
    );
    const bare = draft(lunch, { attendees: [] });
    expect(
      cardLines(bare, draftChanges(placed, bare))
        .filter((line) => line.changed)
        .map((line) => [line.field, line.text, line.was]),
    ).toEqual([
      ['location', 'No place', 'Figlmüller'],
      ['guests', 'No guests', 'Sarah Keller'],
    ]);
    expect(cardLines(bare).map((line) => line.field)).toEqual(['date', 'time']);
  });

  it('lists a reminder’s own fields once it has them', () => {
    const fields = {
      alarms: [15],
      priority: 'high' as const,
      repeat: seedRepeatFields({ freq: 'weekly' }),
      url: '',
    };
    expect(
      cardLines(draft(call, { reminder: fields })).map((line) => [line.field, line.text]),
    ).toEqual([
      ['date', 'Tue, Aug 25'],
      ['time', '09:30'],
      ['repeat', 'Repeats weekly'],
      ['priority', 'High'],
      ['alert', '15 minutes before'],
    ]);
  });
});
