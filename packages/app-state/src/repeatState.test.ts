import { describe, expect, it } from 'vitest';
import { parseRepeatNumber, repeatNumberError } from './repeatState.ts';

describe('parseRepeatNumber', () => {
  it('reads a small positive integer as is', () => {
    expect(parseRepeatNumber('3')).toBe(3);
    expect(parseRepeatNumber(' 12 ')).toBe(12);
  });

  it('never yields something a trapping native cast could choke on', () => {
    // 1e20 parses as 1 (parseInt stops at "e"); huge digits clamp.
    expect(parseRepeatNumber('1e20')).toBe(1);
    expect(parseRepeatNumber('99999999999999999999')).toBe(999);
    expect(parseRepeatNumber('Infinity')).toBe(1);
    expect(parseRepeatNumber('NaN')).toBe(1);
    expect(parseRepeatNumber('')).toBe(1);
    expect(parseRepeatNumber('0')).toBe(1);
    expect(parseRepeatNumber('-4')).toBe(1);
    expect(parseRepeatNumber('3.5')).toBe(3);
  });
});

describe('repeatNumberError', () => {
  it('accepts whole numbers 1…999', () => {
    expect(repeatNumberError('1', 'The repeat interval')).toBeUndefined();
    expect(repeatNumberError('999', 'The repeat interval')).toBeUndefined();
  });

  it('refuses what the form should not send', () => {
    for (const text of ['', '0', '1000', '3.5', '1e20', '-1', 'two']) {
      expect(repeatNumberError(text, 'The repeat interval')).toBe(
        'The repeat interval must be a whole number between 1 and 999.',
      );
    }
  });
});
