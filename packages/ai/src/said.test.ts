import { describe, expect, it } from 'vite-plus/test';
import { saidDate, withoutRuledOut, worked } from './said.ts';

// A Thursday; every date below is worked out from the day a test passes in.
const TODAY = '2026-11-12';

describe('saidDate', () => {
  it('takes a whole date as it is, and none that no calendar has', () => {
    expect(saidDate('2026-11-20', { from: TODAY })).toBe('2026-11-20');
    expect(saidDate('2025-01-03', { from: TODAY })).toBe('2025-01-03');
    expect(saidDate('2026-02-30', { from: TODAY })).toBeUndefined();
  });

  it('finds the year of a month and day: the next one, today included', () => {
    expect(saidDate('03-14', { from: TODAY })).toBe('2027-03-14');
    expect(saidDate('12-24', { from: TODAY })).toBe('2026-12-24');
    expect(saidDate('11-12', { from: TODAY })).toBe('2026-11-12');
    expect(saidDate('11-11', { from: TODAY })).toBe('2027-11-11');
    expect(saidDate('3-4', { from: TODAY })).toBe('2027-03-04');
    expect(saidDate('02-29', { from: '2026-03-01' })).toBe('2028-02-29');
    expect(saidDate('13-01', { from: TODAY })).toBeUndefined();
    expect(saidDate('04-31', { from: TODAY })).toBeUndefined();
  });

  it('finds the month of a day alone: the next one, today included', () => {
    expect(saidDate('14', { from: TODAY })).toBe('2026-11-14');
    expect(saidDate('12', { from: TODAY })).toBe('2026-11-12');
    expect(saidDate('03', { from: TODAY })).toBe('2026-12-03');
    expect(saidDate(3, { from: TODAY })).toBe('2026-12-03');
    expect(saidDate('31', { from: TODAY })).toBe('2026-12-31');
    expect(saidDate('31', { from: '2027-02-01' })).toBe('2027-03-31');
    expect(saidDate('30', { from: '2027-01-31' })).toBe('2027-03-30');
    expect(saidDate('0', { from: TODAY })).toBeUndefined();
    expect(saidDate('32', { from: TODAY })).toBeUndefined();
  });

  it('keeps a day alone in the month of the draft it changes, while that is still ahead', () => {
    expect(saidDate('15', { from: '2026-10-31', near: '2027-03-14' })).toBe('2027-03-15');
    expect(saidDate('15', { from: '2026-10-31', near: '2026-10-20' })).toBe('2026-11-15');
    expect(saidDate('31', { from: '2026-10-31', near: '2027-02-10' })).toBe('2026-10-31');
  });

  it('counts an amount from the day it is given', () => {
    expect(saidDate('+0d', { from: TODAY })).toBe('2026-11-12');
    expect(saidDate('+3d', { from: TODAY })).toBe('2026-11-15');
    expect(saidDate('+2w', { from: TODAY })).toBe('2026-11-26');
    expect(saidDate('+6m', { from: '2026-06-20' })).toBe('2026-12-20');
    expect(saidDate('+1m', { from: '2027-01-31' })).toBe('2027-02-28');
    expect(saidDate('+1y', { from: TODAY })).toBe('2027-11-12');
  });

  it('is nothing for anything else', () => {
    for (const value of [
      'next friday',
      '',
      ' ',
      'FR',
      '+2',
      '2w',
      '2026-11',
      undefined,
      null,
      {},
    ]) {
      expect(saidDate(value, { from: TODAY })).toBeUndefined();
    }
  });
});

describe('withoutRuledOut', () => {
  it('makes every day but some a weekly rule on the days left', () => {
    expect(withoutRuledOut({ except: ['SU'], freq: 'daily' })).toEqual({
      byDay: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA'],
      freq: 'weekly',
    });
    expect(
      withoutRuledOut({ except: ['sa', 'SU'], freq: 'daily', untilDate: '2027-06-30' }),
    ).toEqual({
      byDay: ['MO', 'TU', 'WE', 'TH', 'FR'],
      freq: 'weekly',
      untilDate: '2027-06-30',
    });
  });

  it('takes the days named off a weekly rule and keeps the rest of it', () => {
    expect(
      withoutRuledOut({
        byDay: ['MO', 'TU', 'WE', 'TH', 'FR'],
        except: ['FR'],
        freq: 'weekly',
        interval: 2,
      }),
    ).toEqual({ byDay: ['MO', 'TU', 'WE', 'TH'], freq: 'weekly', interval: 2 });
  });

  it('lets a rule stand where the days named are none of its own, or all of them', () => {
    expect(withoutRuledOut({ byDay: ['MO', 'WE'], except: ['FR'], freq: 'weekly' })).toEqual({
      byDay: ['MO', 'WE'],
      freq: 'weekly',
    });
    expect(withoutRuledOut({ byDay: ['MO'], except: ['MO'], freq: 'weekly' })).toEqual({
      byDay: ['MO'],
      freq: 'weekly',
    });
    expect(withoutRuledOut({ except: ['FR'], freq: 'weekly' })).toEqual({ freq: 'weekly' });
    expect(withoutRuledOut({ byDay: ['2TU'], except: ['TU'], freq: 'monthly' })).toEqual({
      byDay: ['2TU'],
      freq: 'monthly',
    });
  });

  it('returns a rule without ruled-out days as it is', () => {
    expect(withoutRuledOut({ byDay: ['TU'], freq: 'weekly' })).toEqual({
      byDay: ['TU'],
      freq: 'weekly',
    });
    expect(withoutRuledOut({ except: [], freq: 'daily' })).toEqual({ freq: 'daily' });
  });
});

describe('worked', () => {
  it('works out the day, the ruled-out days and a repeat’s end', () => {
    expect(
      worked(
        {
          date: '03',
          kind: 'event',
          repeat: { except: ['SU'], freq: 'daily', untilDate: '06-30' },
          title: 'Yoga',
        },
        { referenceDate: TODAY },
      ),
    ).toEqual({
      date: '2026-12-03',
      kind: 'event',
      repeat: {
        byDay: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA'],
        freq: 'weekly',
        untilDate: '2027-06-30',
      },
      title: 'Yoga',
    });
  });

  it('reads a later turn’s day beside the draft’s', () => {
    expect(
      worked({ date: '15', title: 'Wedding' }, { draftDate: '2027-03-14', referenceDate: TODAY }),
    ).toEqual({ date: '2027-03-15', title: 'Wedding' });
  });

  it('leaves a whole date, a day it cannot read and an answer that is no draft alone', () => {
    const whole = { date: '2026-11-20', repeat: { freq: 'weekly' }, title: 'Standup' };
    expect(worked(whole, { referenceDate: TODAY })).toEqual(whole);
    expect(worked({ date: 'soon', title: 'Call' }, { referenceDate: TODAY })).toEqual({
      date: 'soon',
      title: 'Call',
    });
    expect(worked('no', { referenceDate: TODAY })).toBe('no');
  });
});
