import { describe, expect, it } from 'vite-plus/test';
import { earlierTurnsLabel, visibleTurns } from './threadTurns.ts';

describe('visibleTurns', () => {
  it('has no earlier turns to disclose until the second query', () => {
    expect(visibleTurns([], false)).toEqual({ hidden: 0, shown: [] });
    expect(visibleTurns(['a'], false)).toEqual({ hidden: 0, shown: ['a'] });
    expect(visibleTurns(['a', 'b'], false)).toEqual({ hidden: 1, shown: ['b'] });
  });

  it('shows only the newest turn until expanded', () => {
    expect(visibleTurns(['a', 'b', 'c', 'd', 'e'], false)).toEqual({
      hidden: 4,
      shown: ['e'],
    });
    expect(visibleTurns(['a', 'b', 'c', 'd', 'e'], true)).toEqual({
      hidden: 0,
      shown: ['e', 'd', 'c', 'b', 'a'],
    });
  });
});

describe('earlierTurnsLabel', () => {
  it('counts the turns left out', () => {
    expect(earlierTurnsLabel(1)).toBe('+1 earlier query');
    expect(earlierTurnsLabel(2)).toBe('+2 earlier queries');
  });
});
