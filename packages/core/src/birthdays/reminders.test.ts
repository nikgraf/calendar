import { describe, expect, it } from 'vitest';
import { BirthdayRecord } from '../types.ts';
import { planBirthdayReminders } from './reminders.ts';

const record = (overrides: Partial<BirthdayRecord> = {}): BirthdayRecord =>
  new BirthdayRecord({
    day: 4,
    displayName: 'Alice',
    id: 'device:a',
    month: 3,
    sources: [{ id: 'device:a', source: 'device' }],
    year: 1994,
    ...overrides,
  });

const utc = (iso: string): number => Date.parse(iso);

describe('planBirthdayReminders', () => {
  it('plans one notification per lead at the chosen time, sorted by delivery', () => {
    const plans = planBirthdayReminders(
      [record()],
      { enabled: true, leadDays: [0, 7], time: '09:00' },
      { fromDate: '2026-02-20', horizonDays: 30, timeZone: 'UTC' },
    );
    expect(plans.map((plan) => [plan.key, plan.fireAt, plan.body])).toEqual([
      [
        'device:a:2026-03-04:7',
        utc('2026-02-25T09:00:00Z'),
        'Birthday in a week — turns 32 (Wed, Mar 4)',
      ],
      ['device:a:2026-03-04:0', utc('2026-03-04T09:00:00Z'), 'Birthday today — turns 32'],
    ]);
    expect(plans[0]!.title).toBe('🎂 Alice');
  });

  it('is empty when disabled or without lead days, and drops fire dates before fromDate', () => {
    const disabled = { enabled: false, leadDays: [0 as const], time: '09:00' };
    expect(
      planBirthdayReminders([record()], disabled, {
        fromDate: '2026-03-01',
        horizonDays: 30,
        timeZone: 'UTC',
      }),
    ).toEqual([]);
    const plans = planBirthdayReminders(
      [record()],
      { enabled: true, leadDays: [0, 7], time: '09:00' },
      { fromDate: '2026-03-01', horizonDays: 30, timeZone: 'UTC' },
    );
    expect(plans.map((plan) => plan.key)).toEqual(['device:a:2026-03-04:0']);
  });

  it('reaches into the next year for a lead that fires before the horizon ends', () => {
    const plans = planBirthdayReminders(
      [record({ day: 3, month: 1, year: undefined })],
      { enabled: true, leadDays: [14], time: '08:30' },
      { fromDate: '2026-12-20', horizonDays: 7, timeZone: 'Europe/Vienna' },
    );
    expect(plans.map((plan) => [plan.key, plan.fireAt])).toEqual([
      ['device:a:2027-01-03:14', utc('2026-12-20T07:30:00Z')],
    ]);
    expect(plans[0]!.body).toBe('Birthday in two weeks (Sun, Jan 3)');
  });

  it('handles Feb 29 in common years and a delivery time inside a DST gap', () => {
    const leap = planBirthdayReminders(
      [record({ day: 29, month: 2 })],
      { enabled: true, leadDays: [0], time: '09:00' },
      { fromDate: '2027-02-01', horizonDays: 40, timeZone: 'UTC' },
    );
    expect(leap.map((plan) => plan.key)).toEqual(['device:a:2027-02-28:0']);
    // 02:30 does not exist on 2027-03-28 in Vienna; the clock skips forward.
    const gap = planBirthdayReminders(
      [record({ day: 28, month: 3 })],
      { enabled: true, leadDays: [0], time: '02:30' },
      { fromDate: '2027-03-20', horizonDays: 10, timeZone: 'Europe/Vienna' },
    );
    expect(gap[0]!.fireAt).toBe(utc('2027-03-28T01:30:00Z'));
  });

  it('falls back to 09:00 for a malformed time', () => {
    const plans = planBirthdayReminders(
      [record()],
      { enabled: true, leadDays: [0], time: 'noon' },
      { fromDate: '2026-03-01', horizonDays: 10, timeZone: 'UTC' },
    );
    expect(plans[0]!.fireAt).toBe(utc('2026-03-04T09:00:00Z'));
  });
});
