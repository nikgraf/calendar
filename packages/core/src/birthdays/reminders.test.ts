import { describe, expect, it } from 'vitest';
import { BirthdayRecord } from '../types.ts';
import {
  findBirthdayOverride,
  leadDaysSummary,
  planBirthdayReminders,
  withBirthdayOverride,
} from './reminders.ts';

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

const keys = (plans: ReadonlyArray<{ readonly key: string }>) => plans.map((plan) => plan.key);

describe('planBirthdayReminders', () => {
  it('plans one notification per lead at the chosen time, sorted by delivery', () => {
    const plans = planBirthdayReminders(
      [record()],
      { enabled: true, leadDays: [0, 7], time: '09:00' },
      { fromDate: '2026-02-20', horizonDays: 30, timeZone: 'UTC' },
    );
    expect(plans.map((plan) => [plan.key, plan.fireAt, plan.body])).toEqual([
      [
        'birthday:device:a:2026-03-04:7',
        utc('2026-02-25T09:00:00Z'),
        'Birthday in a week — turns 32 (Wed, Mar 4)',
      ],
      ['birthday:device:a:2026-03-04:0', utc('2026-03-04T09:00:00Z'), 'Birthday today — turns 32'],
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
    expect(plans.map((plan) => plan.key)).toEqual(['birthday:device:a:2026-03-04:0']);
  });

  it('reaches into the next year for a lead that fires before the horizon ends', () => {
    const plans = planBirthdayReminders(
      [record({ day: 3, month: 1, year: undefined })],
      { enabled: true, leadDays: [14], time: '08:30' },
      { fromDate: '2026-12-20', horizonDays: 7, timeZone: 'Europe/Vienna' },
    );
    expect(plans.map((plan) => [plan.key, plan.fireAt])).toEqual([
      ['birthday:device:a:2027-01-03:14', utc('2026-12-20T07:30:00Z')],
    ]);
    expect(plans[0]!.body).toBe('Birthday in two weeks (Sun, Jan 3)');
  });

  it('handles Feb 29 in common years and a delivery time inside a DST gap', () => {
    const leap = planBirthdayReminders(
      [record({ day: 29, month: 2 })],
      { enabled: true, leadDays: [0], time: '09:00' },
      { fromDate: '2027-02-01', horizonDays: 40, timeZone: 'UTC' },
    );
    expect(leap.map((plan) => plan.key)).toEqual(['birthday:device:a:2027-02-28:0']);
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

describe('per-person overrides', () => {
  const on = { enabled: true, leadDays: [0 as const], time: '09:00' };
  const window = { fromDate: '2026-02-01', horizonDays: 60, timeZone: 'UTC' };
  const bob = record({ day: 10, displayName: 'Bob', id: 'device:b', month: 3 });

  it('replaces the general lead days for that person only, matched by name and date', () => {
    // A different id and different case/diacritics: still the same person.
    const overrides = [{ day: 4, displayName: 'ALICE', leadDays: [1, 14] as const, month: 3 }];
    expect(
      keys(
        planBirthdayReminders([record({ id: 'google:acc:people/c1' }), bob], on, window, overrides),
      ),
    ).toEqual([
      'birthday:google:acc:people/c1:2026-03-04:14',
      'birthday:google:acc:people/c1:2026-03-04:1',
      'birthday:device:b:2026-03-10:0',
    ]);
  });

  it('an empty list mutes the person; the general switch still gates everything', () => {
    const muted = [{ day: 4, displayName: 'Alice', leadDays: [] as const, month: 3 }];
    expect(keys(planBirthdayReminders([record(), bob], on, window, muted))).toEqual([
      'birthday:device:b:2026-03-10:0',
    ]);
    const extra = [{ day: 4, displayName: 'Alice', leadDays: [7] as const, month: 3 }];
    expect(planBirthdayReminders([record()], { ...on, enabled: false }, window, extra)).toEqual([]);
  });

  it("reads far enough ahead for an override's longer lead", () => {
    // General [0] alone would stop at Jan 10; Alice's two weeks reach Jan 20.
    const plans = planBirthdayReminders(
      [record({ day: 20, month: 1 })],
      on,
      { fromDate: '2026-01-01', horizonDays: 9, timeZone: 'UTC' },
      [{ day: 20, displayName: 'Alice', leadDays: [14], month: 1 }],
    );
    expect(keys(plans)).toEqual(['birthday:device:a:2026-01-20:14']);
  });

  it('runs with no general lead days when an override has some', () => {
    expect(
      keys(
        planBirthdayReminders([record(), bob], { ...on, leadDays: [] }, window, [
          { day: 10, displayName: 'Bob', leadDays: [0], month: 3 },
        ]),
      ),
    ).toEqual(['birthday:device:b:2026-03-10:0']);
  });

  it('withBirthdayOverride replaces, removes and keeps a canonical order', () => {
    const alice = { day: 4, displayName: 'Alice', month: 3 };
    let overrides = withBirthdayOverride([], bob, [7, 0, 7]);
    overrides = withBirthdayOverride(overrides, alice, [14]);
    expect(overrides).toEqual([
      { day: 4, displayName: 'Alice', leadDays: [14], month: 3 },
      { day: 10, displayName: 'Bob', leadDays: [0, 7], month: 3 },
    ]);
    overrides = withBirthdayOverride(overrides, { ...alice, displayName: 'alice' }, []);
    expect(findBirthdayOverride(overrides, alice)?.leadDays).toEqual([]);
    expect(overrides).toHaveLength(2);
    expect(withBirthdayOverride(overrides, alice, null)).toEqual([
      { day: 10, displayName: 'Bob', leadDays: [0, 7], month: 3 },
    ]);
  });

  it('a rename or another date is another person', () => {
    const overrides = [{ day: 4, displayName: 'Alice', leadDays: [14] as const, month: 3 }];
    expect(findBirthdayOverride(overrides, { day: 4, displayName: 'Alice Smith', month: 3 })).toBe(
      undefined,
    );
    expect(findBirthdayOverride(overrides, { day: 5, displayName: 'Alice', month: 3 })).toBe(
      undefined,
    );
  });

  it('summarises a list the way Settings shows it', () => {
    expect(leadDaysSummary([14, 0])).toBe('On the day, 2 weeks before');
    expect(leadDaysSummary([])).toBe('No reminder');
  });
});
