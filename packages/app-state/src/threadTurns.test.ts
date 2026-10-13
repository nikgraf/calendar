import { describe, expect, it } from 'vite-plus/test';
import { earlierTurnsLabel, visibleTurns } from './threadTurns.ts';

describe('visibleTurns', () => {
  it('lists the turns newest first, all of them while there are two or fewer', () => {
    expect(visibleTurns(['a', 'b'], false)).toEqual({ hidden: 0, shown: ['b', 'a'] });
    expect(visibleTurns([], false)).toEqual({ hidden: 0, shown: [] });
  });

  it('shows the newest two and counts the rest until expanded', () => {
    expect(visibleTurns(['a', 'b', 'c', 'd', 'e'], false)).toEqual({
      hidden: 3,
      shown: ['e', 'd'],
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
