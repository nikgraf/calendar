import { describe, expect, it } from 'vite-plus/test';
import { BirthdayRecord } from '../types.ts';
import {
  addBirthdayReminder,
  type BirthdayLeadDays,
  birthdayRemindersSummary,
  canonicalBirthdayReminders,
  findBirthdayOverride,
  newBirthdayReminderTime,
  planBirthdayReminders,
  removeBirthdayReminder,
  setBirthdayReminderTime,
  upgradeBirthdayReminderData,
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

const at = (leadDays: BirthdayLeadDays, time = '09:00') => ({ leadDays, time });

const keys = (plans: ReadonlyArray<{ readonly key: string }>) => plans.map((plan) => plan.key);

describe('planBirthdayReminders', () => {
  it('plans one notification per lead at the chosen time, sorted by delivery', () => {
    const plans = planBirthdayReminders(
      [record()],
      { enabled: true, reminders: [at(0), at(7)] },
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
    const disabled = { enabled: false, reminders: [at(0)] };
    expect(
      planBirthdayReminders([record()], disabled, {
        fromDate: '2026-03-01',
        horizonDays: 30,
        timeZone: 'UTC',
      }),
    ).toEqual([]);
    const plans = planBirthdayReminders(
      [record()],
      { enabled: true, reminders: [at(0), at(7)] },
      { fromDate: '2026-03-01', horizonDays: 30, timeZone: 'UTC' },
    );
    expect(plans.map((plan) => plan.key)).toEqual(['birthday:device:a:2026-03-04:0']);
  });

  it('reaches into the next year for a lead that fires before the horizon ends', () => {
    const plans = planBirthdayReminders(
      [record({ day: 3, month: 1, year: undefined })],
      { enabled: true, reminders: [at(14, '08:30')] },
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
      { enabled: true, reminders: [at(0)] },
      { fromDate: '2027-02-01', horizonDays: 40, timeZone: 'UTC' },
    );
    expect(leap.map((plan) => plan.key)).toEqual(['birthday:device:a:2027-02-28:0']);
    // 02:30 does not exist on 2027-03-28 in Vienna; the clock skips forward.
    const gap = planBirthdayReminders(
      [record({ day: 28, month: 3 })],
      { enabled: true, reminders: [at(0, '02:30')] },
      { fromDate: '2027-03-20', horizonDays: 10, timeZone: 'Europe/Vienna' },
    );
    expect(gap[0]!.fireAt).toBe(utc('2027-03-28T01:30:00Z'));
  });

  it('falls back to 09:00 for a malformed time', () => {
    const plans = planBirthdayReminders(
      [record()],
      { enabled: true, reminders: [at(0, 'noon')] },
      { fromDate: '2026-03-01', horizonDays: 10, timeZone: 'UTC' },
    );
    expect(plans[0]!.fireAt).toBe(utc('2026-03-04T09:00:00Z'));
  });
});

describe('per-person overrides', () => {
  const on = { enabled: true, reminders: [at(0)] };
  const window = { fromDate: '2026-02-01', horizonDays: 60, timeZone: 'UTC' };
  const bob = record({ day: 10, displayName: 'Bob', id: 'device:b', month: 3 });

  it('replaces the general lead days for that person only, matched by name and date', () => {
    // A different id and different case/diacritics: still the same person.
    const overrides = [{ day: 4, displayName: 'ALICE', month: 3, reminders: [at(1), at(14)] }];
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
    const muted = [{ day: 4, displayName: 'Alice', month: 3, reminders: [] }];
    expect(keys(planBirthdayReminders([record(), bob], on, window, muted))).toEqual([
      'birthday:device:b:2026-03-10:0',
    ]);
    const extra = [{ day: 4, displayName: 'Alice', month: 3, reminders: [at(7)] }];
    expect(planBirthdayReminders([record()], { ...on, enabled: false }, window, extra)).toEqual([]);
  });

  it("reads far enough ahead for an override's longer lead", () => {
    // General [0] alone would stop at Jan 10; Alice's two weeks reach Jan 20.
    const plans = planBirthdayReminders(
      [record({ day: 20, month: 1 })],
      on,
      { fromDate: '2026-01-01', horizonDays: 9, timeZone: 'UTC' },
      [{ day: 20, displayName: 'Alice', month: 1, reminders: [at(14)] }],
    );
    expect(keys(plans)).toEqual(['birthday:device:a:2026-01-20:14']);
  });

  it('runs with no general lead days when an override has some', () => {
    expect(
      keys(
        planBirthdayReminders([record(), bob], { ...on, reminders: [] }, window, [
          { day: 10, displayName: 'Bob', month: 3, reminders: [at(0)] },
        ]),
      ),
    ).toEqual(['birthday:device:b:2026-03-10:0']);
  });

  it('withBirthdayOverride replaces, removes and keeps a canonical order', () => {
    const alice = { day: 4, displayName: 'Alice', month: 3 };
    let overrides = withBirthdayOverride([], bob, [at(7, '18:00'), at(0), at(7, '20:00')]);
    overrides = withBirthdayOverride(overrides, alice, [at(14)]);
    expect(overrides).toEqual([
      { day: 4, displayName: 'Alice', month: 3, reminders: [at(14)] },
      { day: 10, displayName: 'Bob', month: 3, reminders: [at(0), at(7, '20:00')] },
    ]);
    overrides = withBirthdayOverride(overrides, { ...alice, displayName: 'alice' }, []);
    expect(findBirthdayOverride(overrides, alice)?.reminders).toEqual([]);
    expect(overrides).toHaveLength(2);
    expect(withBirthdayOverride(overrides, alice, null)).toEqual([
      { day: 10, displayName: 'Bob', month: 3, reminders: [at(0), at(7, '20:00')] },
    ]);
  });

  it('a rename or another date is another person', () => {
    const overrides = [{ day: 4, displayName: 'Alice', month: 3, reminders: [at(14)] }];
    expect(findBirthdayOverride(overrides, { day: 4, displayName: 'Alice Smith', month: 3 })).toBe(
      undefined,
    );
    expect(findBirthdayOverride(overrides, { day: 5, displayName: 'Alice', month: 3 })).toBe(
      undefined,
    );
  });

  it('summarises a list the way Settings shows it', () => {
    expect(birthdayRemindersSummary([at(14, '18:30'), at(0)])).toBe(
      'On the day at 9:00 AM, 2 weeks before at 6:30 PM',
    );
    expect(birthdayRemindersSummary([at(1, 'noon')])).toBe('1 day before at 9:00 AM');
    expect(birthdayRemindersSummary([])).toBe('No reminder');
  });
});

describe('each reminder at its own time', () => {
  it('fires every lead at its own time of day', () => {
    const plans = planBirthdayReminders(
      [record()],
      { enabled: true, reminders: [at(3, '18:00'), at(0, '07:15')] },
      { fromDate: '2026-02-20', horizonDays: 30, timeZone: 'Europe/Vienna' },
    );
    expect(plans.map((plan) => [plan.key, plan.fireAt])).toEqual([
      ['birthday:device:a:2026-03-04:3', utc('2026-03-01T17:00:00Z')],
      ['birthday:device:a:2026-03-04:0', utc('2026-03-04T06:15:00Z')],
    ]);
  });

  it("gives a person's own reminders their own times", () => {
    const plans = planBirthdayReminders(
      [record()],
      { enabled: true, reminders: [at(0)] },
      { fromDate: '2026-02-20', horizonDays: 30, timeZone: 'UTC' },
      [{ day: 4, displayName: 'Alice', month: 3, reminders: [at(0, '20:00'), at(1, '08:00')] }],
    );
    expect(plans.map((plan) => [plan.key, plan.fireAt])).toEqual([
      ['birthday:device:a:2026-03-04:1', utc('2026-03-03T08:00:00Z')],
      ['birthday:device:a:2026-03-04:0', utc('2026-03-04T20:00:00Z')],
    ]);
  });

  it('plans one notification per lead even from a list that repeats one', () => {
    const plans = planBirthdayReminders(
      [record()],
      { enabled: true, reminders: [at(0, '08:00'), at(0, '10:00')] },
      { fromDate: '2026-03-01', horizonDays: 10, timeZone: 'UTC' },
    );
    expect(plans.map((plan) => plan.fireAt)).toEqual([utc('2026-03-04T10:00:00Z')]);
  });

  it('keeps one reminder per lead, soonest lead first, the last one given winning', () => {
    expect(canonicalBirthdayReminders([at(7, '18:00'), at(0), at(7, '20:00')])).toEqual([
      at(0),
      at(7, '20:00'),
    ]);
  });

  it('starts a new lead at the nearest reminder’s time, 09:00 for the first', () => {
    expect(newBirthdayReminderTime([], 3)).toBe('09:00');
    expect(newBirthdayReminderTime([at(0, '07:00'), at(14, '19:00')], 3)).toBe('07:00');
    expect(newBirthdayReminderTime([at(0, '07:00'), at(14, '19:00')], 7)).toBe('07:00');
    expect(newBirthdayReminderTime([at(1, '07:00'), at(14, '19:00')], 7)).toBe('07:00');
    expect(newBirthdayReminderTime([at(3, '07:00'), at(14, '19:00')], 7)).toBe('07:00');
    expect(newBirthdayReminderTime([at(0, '07:00'), at(7, '19:00')], 14)).toBe('19:00');
  });

  it('adds, moves and removes one reminder, keeping the list canonical', () => {
    const added = addBirthdayReminder([at(7, '18:00')], 1);
    expect(added).toEqual([at(1, '18:00'), at(7, '18:00')]);
    expect(addBirthdayReminder(added, 1)).toEqual(added);
    expect(setBirthdayReminderTime(added, 1, '06:45')).toEqual([at(1, '06:45'), at(7, '18:00')]);
    expect(removeBirthdayReminder(added, 7)).toEqual([at(1, '18:00')]);
  });
});

describe('upgradeBirthdayReminderData', () => {
  it('gives every lead of the old shape the one time it shared, a person’s too', () => {
    expect(
      upgradeBirthdayReminderData({
        overrides: [
          { day: 4, displayName: 'Alice', leadDays: [14, 1], month: 3 },
          { day: 10, displayName: 'Bob', leadDays: [], month: 3 },
        ],
        settings: { enabled: true, leadDays: [0, 7], time: '18:30' },
      }),
    ).toEqual({
      overrides: [
        { day: 4, displayName: 'Alice', month: 3, reminders: [at(14, '18:30'), at(1, '18:30')] },
        { day: 10, displayName: 'Bob', month: 3, reminders: [] },
      ],
      settings: { enabled: true, reminders: [at(0, '18:30'), at(7, '18:30')] },
    });
  });

  it('passes today’s shape and anything unrecognised through', () => {
    const today = {
      overrides: [{ day: 4, displayName: 'Alice', month: 3, reminders: [at(1, '07:00')] }],
      settings: { enabled: true, reminders: [at(0, '20:00')] },
    };
    expect(upgradeBirthdayReminderData(today)).toEqual(today);
    expect(upgradeBirthdayReminderData({ overrides: undefined, settings: null })).toEqual({
      overrides: undefined,
      settings: null,
    });
    expect(upgradeBirthdayReminderData({ overrides: 'x', settings: { leadDays: 3 } })).toEqual({
      overrides: 'x',
      settings: { leadDays: 3 },
    });
  });

  it('times an old person’s entry from the general reminders, or 09:00 without any', () => {
    const alice = { day: 4, displayName: 'Alice', leadDays: [1], month: 3 };
    expect(
      upgradeBirthdayReminderData({
        overrides: [alice],
        settings: { enabled: true, reminders: [at(3, '21:00')] },
      }).overrides,
    ).toEqual([{ day: 4, displayName: 'Alice', month: 3, reminders: [at(1, '21:00')] }]);
    expect(
      upgradeBirthdayReminderData({ overrides: [alice], settings: undefined }).overrides,
    ).toEqual([{ day: 4, displayName: 'Alice', month: 3, reminders: [at(1)] }]);
  });
});
