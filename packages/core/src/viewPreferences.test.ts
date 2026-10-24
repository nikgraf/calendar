import { describe, expect, it } from 'vite-plus/test';
import { expandedAllDayRows, MAX_ALL_DAY_ROWS } from './viewPreferences.ts';

describe('expandedAllDayRows', () => {
  it('takes whole rows from a third of the view', () => {
    // 800 / 3 = 266.7 px of 24 px rows.
    expect(expandedAllDayRows(800, 24)).toBe(11);
    expect(expandedAllDayRows(600, 24)).toBe(8);
  });

  it('never shows fewer rows than the collapsed lane', () => {
    expect(expandedAllDayRows(120, 24)).toBe(MAX_ALL_DAY_ROWS);
    expect(expandedAllDayRows(0, 24)).toBe(MAX_ALL_DAY_ROWS);
  });
});
