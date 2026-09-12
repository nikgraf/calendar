import { describe, expect, it } from 'vitest';
import { BirthdayRecord } from '../types.ts';
import { birthdayChipLabel } from './label.ts';
import { birthdayMergeKey, birthdaysInRange, describeBirthday, mergeBirthdays } from './model.ts';

const google = (overrides: Partial<BirthdayRecord> = {}): BirthdayRecord =>
  new BirthdayRecord({
    day: 4,
    displayName: 'Zoë Müller',
    id: 'google:acc-1:people/c1',
    month: 3,
    sources: [
      {
        accountEmail: 'nik@example.com',
        accountId: 'acc-1',
        id: 'google:acc-1:people/c1',
        source: 'google',
      },
    ],
    year: 1994,
    ...overrides,
  });

const device = (overrides: Partial<BirthdayRecord> = {}): BirthdayRecord =>
  new BirthdayRecord({
    day: 4,
    displayName: 'zoe  muller',
    id: 'device:ABC',
    month: 3,
    sources: [{ id: 'device:ABC', source: 'device' }],
    ...overrides,
  });

describe('birthdayMergeKey', () => {
  it('folds diacritics, case and whitespace, and appends MM-DD', () => {
    expect(birthdayMergeKey(google())).toBe('zoe muller:03-04');
    expect(birthdayMergeKey(device())).toBe('zoe muller:03-04');
  });
});

describe('mergeBirthdays', () => {
  it('merges the same person from both sources, Google first, keeping the known year', () => {
    const merged = mergeBirthdays([device(), google()]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe('google:acc-1:people/c1');
    expect(merged[0]!.year).toBe(1994);
    expect(merged[0]!.sources.map((source) => source.source)).toEqual(['google', 'device']);
  });

  it('keeps two people apart when their years disagree', () => {
    const merged = mergeBirthdays([google(), device({ year: 1960 })]);
    expect(merged).toHaveLength(2);
  });

  it('leaves unrelated records alone', () => {
    const merged = mergeBirthdays([google(), device({ displayName: 'Someone Else' })]);
    expect(merged).toHaveLength(2);
  });
});

describe('birthdaysInRange', () => {
  it('expands one occurrence per year inside the window, across a year boundary', () => {
    const record = google({ day: 1, month: 1, year: 2000 });
    const occurrences = birthdaysInRange([record], '2026-12-28', '2027-01-04');
    expect(occurrences.map((occurrence) => occurrence.date)).toEqual(['2027-01-01']);
    expect(occurrences[0]!.age).toBe(27);
  });

  it('places Feb 29 on Feb 28 in a common year and on Feb 29 in a leap year', () => {
    const record = google({ day: 29, month: 2, year: undefined });
    expect(birthdaysInRange([record], '2027-02-25', '2027-03-02')[0]!.date).toBe('2027-02-28');
    expect(birthdaysInRange([record], '2028-02-25', '2028-03-02')[0]!.date).toBe('2028-02-29');
  });

  it('omits the age when the year is unknown or is the birth year, and sorts by date then name', () => {
    const born = google({ day: 10, month: 6, year: 2026 });
    const later = google({ day: 12, displayName: 'Bob', month: 6, year: undefined });
    const same = google({ day: 10, displayName: 'Ann', month: 6, year: undefined });
    const occurrences = birthdaysInRange([later, born, same], '2026-06-01', '2026-06-30');
    expect(occurrences.map((occurrence) => occurrence.record.displayName)).toEqual([
      'Ann',
      'Zoë Müller',
      'Bob',
    ]);
    expect(occurrences.every((occurrence) => occurrence.age === undefined)).toBe(true);
  });

  it('returns nothing outside the window', () => {
    expect(birthdaysInRange([google()], '2026-03-05', '2026-03-20')).toEqual([]);
  });
});

describe('describeBirthday', () => {
  it('reports today, the next occurrence and the age turning', () => {
    expect(describeBirthday({ day: 4, month: 3, year: 1994 }, '2026-03-04')).toEqual({
      ageTurning: 32,
      daysUntil: 0,
      nextDate: '2026-03-04',
    });
    expect(describeBirthday({ day: 4, month: 3, year: 1994 }, '2026-03-05')).toEqual({
      ageTurning: 33,
      daysUntil: 364,
      nextDate: '2027-03-04',
    });
    expect(describeBirthday({ day: 4, month: 3 }, '2026-02-20')).toEqual({
      daysUntil: 12,
      nextDate: '2026-03-04',
    });
  });
});

describe('birthdayChipLabel', () => {
  it('leads with the cake and appends the age when known', () => {
    expect(birthdayChipLabel({ record: { displayName: 'Ann' } })).toBe('🎂 Ann');
    expect(birthdayChipLabel({ age: 40, record: { displayName: 'Ann' } })).toBe('🎂 Ann (40)');
  });
});
