import { describe, expect, it } from 'vitest';
import { Temporal } from '../time/temporal.ts';
import { monthCellLabel } from './monthCellLabel.ts';

const date = Temporal.PlainDate.from('2026-09-15');

describe('monthCellLabel', () => {
  it('lists the non-zero counts in display order, singular and plural', () => {
    expect(monthCellLabel(date, { birthdays: 1, events: 2, tasks: 1 })).toBe(
      'Tuesday, September 15, 2 events, 1 birthday, 1 task',
    );
    expect(monthCellLabel(date, { birthdays: 0, events: 0, tasks: 3 })).toBe(
      'Tuesday, September 15, 3 tasks',
    );
  });

  it('says so when nothing is scheduled', () => {
    expect(monthCellLabel(date, { birthdays: 0, events: 0, tasks: 0 })).toBe(
      'Tuesday, September 15, nothing scheduled',
    );
  });
});
