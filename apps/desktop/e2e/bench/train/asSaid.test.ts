import { describe, expect, it } from 'vite-plus/test';
import { worked } from '../said.ts';
import { asSaid, buildSaidPrompt, type Said, saidOf } from './asSaid.ts';

const other: Said = { day: { how: 'other' }, except: [] };

describe('saidOf', () => {
  it('holds a second answer to what it may say', () => {
    expect(saidOf({ dayOfMonth: 14, except: [], how: 'number' })).toEqual({
      day: { dayOfMonth: 14, how: 'number' },
      except: [],
    });
    expect(saidOf({ dayOfMonth: 14, except: ['SU', 'XX'], how: 'number', month: 3 })).toEqual({
      day: { dayOfMonth: 14, how: 'number', month: 3 },
      except: ['SU'],
    });
    expect(saidOf({ amount: 2, except: [], how: 'offset', unit: 'week' })).toEqual({
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
