import { describe, expect, it } from 'vitest';
import {
  calendarKey,
  contrastingTextColor,
  eventKey,
  makeColorLookup,
  normalizeHexColor,
} from './color.ts';

describe('color', () => {
  it('picks dark text on light backgrounds and light text on dark ones', () => {
    expect(contrastingTextColor('#ffffff')).toBe('#1f2937');
    expect(contrastingTextColor('#000000')).toBe('#ffffff');
    // Google's blue is dark enough for white text.
    expect(contrastingTextColor('#4285f4')).toBe('#ffffff');
    // Luminance is weighted, not a mean: yellow is light, blue is dark…
    expect(contrastingTextColor('#ffff00')).toBe('#1f2937');
    expect(contrastingTextColor('#0000ff')).toBe('#ffffff');
    // …and pure green lands just under the 160 threshold (0.587 * 255 ≈ 150),
    // so it takes white text despite looking bright.
    expect(contrastingTextColor('#00ff00')).toBe('#ffffff');
  });

  it('normalizes only full six-digit hex colors', () => {
    expect(normalizeHexColor('#AABBCC')).toBe('#aabbcc');
    expect(normalizeHexColor('  #aabbcc  ')).toBe('#aabbcc');
    // Rejected: shorthand, missing hash, bad characters, wrong length.
    expect(normalizeHexColor('#abc')).toBeUndefined();
    expect(normalizeHexColor('aabbcc')).toBeUndefined();
    expect(normalizeHexColor('#gggggg')).toBeUndefined();
    expect(normalizeHexColor('#aabbccdd')).toBeUndefined();
    expect(normalizeHexColor('')).toBeUndefined();
  });

  it('builds composite keys the whole app agrees on', () => {
    expect(calendarKey({ accountId: 'acc', id: 'cal' })).toBe('acc:cal');
    expect(eventKey({ calendarId: 'cal', id: 'evt' })).toBe('cal:evt');
  });

  it('maps events to their calendar color, falling back to Google blue', () => {
    const lookup = makeColorLookup([
      { accountId: 'acc', colorHex: '#ff0000', id: 'work' },
      { accountId: 'other', colorHex: '#00ff00', id: 'work' },
    ]);
    expect(lookup({ accountId: 'acc', calendarId: 'work' })).toBe('#ff0000');
    // Same calendar id under a different account must not collide.
    expect(lookup({ accountId: 'other', calendarId: 'work' })).toBe('#00ff00');
    expect(lookup({ accountId: 'acc', calendarId: 'unknown' })).toBe('#4285f4');
  });
});
