import { describe, expect, it } from 'vitest';
import { Temporal } from '../time/temporal.ts';
import { bufferedDays, bufferedRange } from './dayStrip.ts';

const MONDAY = Temporal.PlainDate.from('2026-08-17');

describe('dayStrip', () => {
  it('surrounds the visible days with buffer neighbours', () => {
    expect(bufferedDays(MONDAY, 1, 1).map(String)).toEqual([
      '2026-08-16',
      '2026-08-17',
      '2026-08-18',
    ]);
    expect(bufferedDays(MONDAY, 7, 2)).toHaveLength(11);
    expect(bufferedDays(MONDAY, 7, 2)[0]!.toString()).toBe('2026-08-15');
  });

  it('renders only the visible days when there is no buffer', () => {
    expect(bufferedDays(MONDAY, 7, 0).map(String)[0]).toBe('2026-08-17');
    expect(bufferedDays(MONDAY, 7, 0)).toHaveLength(7);
  });

  it('covers exactly the rendered days in the fetch range', () => {
    const days = bufferedDays(MONDAY, 7, 2);
    const range = bufferedRange(MONDAY, 7, 2, 'Europe/Vienna');
    const firstStart = days[0]!.toZonedDateTime({ timeZone: 'Europe/Vienna' }).startOfDay();
    const afterLast = days
      .at(-1)!
      .add({ days: 1 })
      .toZonedDateTime({ timeZone: 'Europe/Vienna' })
      .startOfDay();
    expect(range.startUtc).toBe(firstStart.toInstant().epochMilliseconds);
    expect(range.endUtc).toBe(afterLast.toInstant().epochMilliseconds);
  });
});
