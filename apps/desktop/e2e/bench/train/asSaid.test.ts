import { describe, expect, it } from 'vite-plus/test';
import { worked, workedTimes } from '@calendar/ai';
import { asSaid, buildSaidPrompt, type Said, saidOf } from './asSaid.ts';

const other: Said = { day: { how: 'other' }, except: [] };

describe('saidOf', () => {
  it('holds a second answer to what it may say', () => {
    // No time said: neither a start nor an end.
    expect(saidOf({ dayOfMonth: 14, except: [], how: 'number' })).toMatchObject({
      end: { how: 'other' },
      start: { how: 'other' },
    });
    expect(saidOf({ dayOfMonth: 14, except: [], how: 'number' })).toMatchObject({
      day: { dayOfMonth: 14, how: 'number' },
      except: [],
    });
    expect(saidOf({ dayOfMonth: 14, except: ['SU', 'XX'], how: 'number', month: 3 })).toMatchObject(
      {
        day: { dayOfMonth: 14, how: 'number', month: 3 },
        except: ['SU'],
      },
    );
    expect(saidOf({ amount: 2, except: [], how: 'offset', unit: 'week' })).toMatchObject({
      day: { amount: 2, how: 'offset', unit: 'w' },
      except: [],
    });
  });

  it('reads an answer that lacks its numbers as no day said', () => {
    expect(saidOf({ except: [], how: 'number' })?.day).toEqual({ how: 'other' });
    expect(saidOf({ dayOfMonth: 40, except: [], how: 'number' })?.day).toEqual({ how: 'other' });
    expect(saidOf({ amount: 2, except: [], how: 'offset' })?.day).toEqual({ how: 'other' });
    expect(saidOf({ except: [], how: 'weekday' })?.day).toEqual({ how: 'other' });
    expect(saidOf('number')).toBeUndefined();
  });

  it('drops a year said without its month', () => {
    expect(saidOf({ dayOfMonth: 3, except: [], how: 'number', year: 2027 })?.day).toEqual({
      dayOfMonth: 3,
      how: 'number',
    });
  });
});

describe('asSaid', () => {
  it('writes a day of the month as said, whichever month the teacher took', () => {
    const answer = { date: '2026-11-14', kind: 'event', title: 'Dentist' };
    const { answer: written, forms } = asSaid(
      answer,
      { day: { dayOfMonth: 14, how: 'number' }, except: [] },
      { referenceDate: '2026-10-17' },
    );
    expect(written).toEqual({ date: '14', kind: 'event', title: 'Dentist' });
    expect(forms).toEqual(['day']);
    // The code's month is the next 14th, not the teacher's.
    expect(worked(written, { referenceDate: '2026-10-17' })).toMatchObject({ date: '2026-11-14' });
  });

  it('writes a month and day as said, and the code puts a date the teacher left behind ahead', () => {
    const { answer: written, forms } = asSaid(
      { date: '2026-06-22', kind: 'event', title: 'Sommerfest Kindergarten' },
      { day: { dayOfMonth: 22, how: 'number', month: 6 }, except: [] },
      { referenceDate: '2026-10-28' },
    );
    expect(written['date']).toBe('06-22');
    expect(forms).toEqual(['monthDay']);
    expect(worked(written, { referenceDate: '2026-10-28' })).toMatchObject({ date: '2027-06-22' });
  });

  it('keeps the teacher’s date where the day said is not the day it is on', () => {
    // "remind me two days before the flight on March 22": the teacher's day is the 20th.
    const answer = { date: '2028-03-20', kind: 'task', title: 'print the boarding pass' };
    expect(
      asSaid(
        answer,
        { day: { dayOfMonth: 22, how: 'number', month: 3 }, except: [] },
        { referenceDate: '2027-08-21' },
      ),
    ).toEqual({ answer, forms: [] });
    expect(
      asSaid(
        { ...answer, date: '2028-04-22' },
        { day: { dayOfMonth: 22, how: 'number', month: 3 }, except: [] },
        { referenceDate: '2027-08-21' },
      ).forms,
    ).toEqual([]);
  });

  it('keeps a date said with its year, a date that is none, and an answer nothing was said about', () => {
    const answer = { date: '2027-11-03', kind: 'event', title: 'Party' };
    const context = { referenceDate: '2026-02-24' };
    expect(
      asSaid(
        answer,
        { day: { dayOfMonth: 3, how: 'number', month: 11, year: 2027 }, except: [] },
        context,
      ),
    ).toEqual({ answer, forms: [] });
    expect(asSaid(answer, other, context)).toEqual({ answer, forms: [] });
    expect(asSaid(answer, undefined, context)).toEqual({ answer, forms: [] });
    const dateless = { kind: 'task', title: 'Pay the bill' };
    expect(
      asSaid(dateless, { day: { dayOfMonth: 3, how: 'number' }, except: [] }, context),
    ).toEqual({ answer: dateless, forms: [] });
  });

  it('writes an amount from today where the sum is the teacher’s date, and not otherwise', () => {
    const context = { referenceDate: '2026-06-20' };
    const halfYear: Said = { day: { amount: 6, how: 'offset', unit: 'm' }, except: [] };
    expect(asSaid({ date: '2026-12-20', title: 'Zahnarzt' }, halfYear, context)).toEqual({
      answer: { date: '+6m', title: 'Zahnarzt' },
      forms: ['offset'],
    });
    expect(asSaid({ date: '2026-12-21', title: 'Zahnarzt' }, halfYear, context).forms).toEqual([]);
  });

  it('writes a later turn’s new day as said', () => {
    const { answer: written } = asSaid(
      { date: '2027-03-15', kind: 'event', title: 'Wedding' },
      { day: { dayOfMonth: 15, how: 'number' }, except: [] },
      { draftDate: '2027-03-14', referenceDate: '2026-10-31' },
    );
    expect(written['date']).toBe('15');
    expect(worked(written, { draftDate: '2027-03-14', referenceDate: '2026-10-31' })).toMatchObject(
      { date: '2027-03-15' },
    );
  });

  it('puts ruled-out weekdays beside the rule they are taken from', () => {
    const context = { referenceDate: '2026-11-12' };
    const weekdays = asSaid(
      {
        date: '2026-11-12',
        repeat: { byDay: ['MO', 'TU', 'WE', 'TH'], freq: 'weekly', untilDate: '2027-06-30' },
        title: 'Standup',
      },
      { day: { how: 'other' }, except: ['FR'] },
      context,
    );
    expect(weekdays.answer['repeat']).toEqual({
      byDay: ['MO', 'TU', 'WE', 'TH', 'FR'],
      except: ['FR'],
      freq: 'weekly',
      untilDate: '2027-06-30',
    });
    expect(weekdays.forms).toEqual(['except']);
    const everyDay = asSaid(
      {
        date: '2026-11-12',
        repeat: { byDay: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA'], freq: 'weekly' },
        title: 'Yoga',
      },
      { day: { how: 'other' }, except: ['SU'] },
      context,
    );
    expect(everyDay.answer['repeat']).toEqual({ except: ['SU'], freq: 'daily' });
    // A teacher that missed the exception is put right by what was said.
    const missed = asSaid(
      { date: '2026-11-12', repeat: { freq: 'daily' }, title: 'Yoga' },
      { day: { how: 'other' }, except: ['SU'] },
      context,
    );
    expect(worked(missed.answer, context)).toMatchObject({
      repeat: { byDay: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA'], freq: 'weekly' },
    });
    for (const { answer } of [weekdays, everyDay]) {
      expect(worked(answer, context)).toMatchObject({
        repeat: { freq: 'weekly' },
      });
    }
  });

  it('leaves a rule without weekdays of its own, and an answer without a repeat, alone', () => {
    const context = { referenceDate: '2026-11-12' };
    const exceptFriday: Said = { day: { how: 'other' }, except: ['FR'] };
    const monthly = {
      date: '2026-11-12',
      repeat: { byDay: ['2TU'], freq: 'monthly' },
      title: 'Club',
    };
    expect(asSaid(monthly, exceptFriday, context)).toEqual({ answer: monthly, forms: [] });
    const weekly = { date: '2026-11-12', repeat: { freq: 'weekly' }, title: 'Club' };
    expect(asSaid(weekly, exceptFriday, context)).toEqual({ answer: weekly, forms: [] });
    const once = { date: '2026-11-12', title: 'Club' };
    expect(asSaid(once, exceptFriday, context)).toEqual({ answer: once, forms: [] });
  });
});

const said = (over: Partial<Said>): Said => ({ ...other, ...over });

describe('asSaid, no day and times', () => {
  it('reads the second answer’s times: an amount later or earlier, a length, nothing else', () => {
    expect(
      saidOf({ end: 'other', except: [], how: 'none', start: 'later', startMinutes: 30 }),
    ).toEqual({
      day: { how: 'none' },
      end: { how: 'other' },
      except: [],
      noAlert: false,
      start: { how: 'shift', minutes: 30 },
    });
    expect(
      saidOf({ end: 'shorter', endMinutes: 15, except: [], how: 'other', start: 'clock' }),
    ).toMatchObject({ end: { how: 'shift', minutes: -15 }, start: { how: 'other' } });
    expect(
      saidOf({ end: 'length', endMinutes: 45, except: [], how: 'other', start: 'other' }),
    ).toMatchObject({ end: { how: 'length', minutes: 45 } });
    // An amount without its minutes, or a day or more, is no amount.
    expect(
      saidOf({ end: 'length', except: [], how: 'other', start: 'earlier', startMinutes: 1440 }),
    ).toMatchObject({ end: { how: 'other' }, start: { how: 'other' } });
  });

  it('leaves the day out where none was said and the teacher’s is the one the code takes', () => {
    const lunch = { date: '2026-11-13', kind: 'event', startTime: '13:00', title: 'Lunch' };
    const first = asSaid(lunch, said({ day: { how: 'none' } }), { referenceDate: '2026-11-13' });
    expect(first.answer).toEqual({ kind: 'event', startTime: '13:00', title: 'Lunch' });
    expect(first.forms).toEqual(['noDay']);
    // A teacher that put an unsaid day elsewhere keeps it: the code would not find it.
    const elsewhere = asSaid(lunch, said({ day: { how: 'none' } }), {
      referenceDate: '2026-11-12',
    });
    expect(elsewhere.answer).toEqual(lunch);
    // A later turn: the draft's day.
    const later = asSaid(lunch, said({ day: { how: 'none' } }), {
      draftDate: '2026-11-13',
      referenceDate: '2026-11-01',
    });
    expect(later.answer).not.toHaveProperty('date');
    // A day said is kept, even today.
    expect(asSaid(lunch, other, { referenceDate: '2026-11-13' }).answer).toEqual(lunch);
  });

  it('writes a shift of a later turn as said, the end with it where it moved as far', () => {
    const draftTimes = { endTime: '18:00', startTime: '17:00' };
    const moved = {
      date: '2026-11-13',
      endTime: '18:30',
      kind: 'event',
      startTime: '17:30',
      title: 'Call',
    };
    const { answer, forms } = asSaid(moved, said({ start: { how: 'shift', minutes: 30 } }), {
      draftDate: '2026-11-13',
      draftTimes,
      referenceDate: '2026-11-13',
    });
    expect(answer).toMatchObject({ endTime: '+30m', startTime: '+30m' });
    expect(forms).toEqual(['shift']);
    // The code moves the draft's times back to the teacher's.
    expect(
      workedTimes(answer, { draft: { date: '2026-11-13', isAllDay: false, ...draftTimes } }),
    ).toMatchObject({ endTime: '18:30', startTime: '17:30' });
    // An amount that is not the teacher's move stays a clock time.
    const wrong = asSaid(moved, said({ start: { how: 'shift', minutes: 60 } }), {
      draftTimes,
      referenceDate: '2026-11-13',
    });
    expect(wrong.answer).toEqual(moved);
  });

  it('writes a length after the start, and an end moved with the start kept', () => {
    const first = asSaid(
      { endTime: '17:45', kind: 'event', startTime: '17:00', title: 'Run' },
      said({ end: { how: 'length', minutes: 45 } }),
      { referenceDate: '2026-11-13' },
    );
    expect(first.answer).toMatchObject({ endTime: '45m', startTime: '17:00' });
    expect(first.forms).toEqual(['length']);
    const longer = asSaid(
      { endTime: '18:10', kind: 'event', startTime: '17:00', title: 'Run' },
      said({ end: { how: 'shift', minutes: 10 } }),
      { draftTimes: { endTime: '18:00', startTime: '17:00' }, referenceDate: '2026-11-13' },
    );
    expect(longer.answer).toMatchObject({ endTime: '+10m', startTime: '17:00' });
    // A length the teacher's times do not span stays a clock time.
    const off = asSaid(
      { endTime: '18:00', kind: 'event', startTime: '17:00', title: 'Run' },
      said({ end: { how: 'length', minutes: 45 } }),
      { referenceDate: '2026-11-13' },
    );
    expect(off.answer['endTime']).toBe('18:00');
  });
});

describe('asSaid, notifications', () => {
  const lunch = { kind: 'event', startTime: '13:00', title: 'Lunch' };

  it('writes an empty list where the words ask for no notification, and only there', () => {
    const none = asSaid(lunch, said({ noAlert: true }), { referenceDate: '2026-11-13' });
    expect(none.answer).toEqual({ ...lunch, reminders: [] });
    expect(none.forms).toEqual(['noAlert']);
    // A teacher's empty list for words that say nothing about notifications goes.
    expect(
      asSaid({ ...lunch, reminders: [] }, other, { referenceDate: '2026-11-13' }).answer,
    ).toEqual(lunch);
    expect(
      asSaid({ ...lunch, reminders: [] }, undefined, { referenceDate: '2026-11-13' }).answer,
    ).toEqual(lunch);
    // A list the teacher filled stays, whatever the second answer says.
    expect(
      asSaid({ ...lunch, reminders: [30] }, said({ noAlert: true }), {
        referenceDate: '2026-11-13',
      }).answer,
    ).toEqual({ ...lunch, reminders: [30] });
  });
});

describe('buildSaidPrompt', () => {
  it('asks about a first phrase, and about what is said now beside what was said before', () => {
    const first = buildSaidPrompt({ earlier: [], text: 'haircut on the 23rd' });
    expect(first.endsWith('Phrase: haircut on the 23rd')).toBe(true);
    expect(first).not.toContain('Said before');
    const later = buildSaidPrompt({ earlier: ['haircut on the 23rd'], text: 'make it the 24th' });
    expect(later).toContain('Said before: ["haircut on the 23rd"]');
    expect(later.endsWith('Now: make it the 24th')).toBe(true);
  });
});
