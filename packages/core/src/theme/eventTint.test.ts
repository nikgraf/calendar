import { describe, expect, it } from 'vite-plus/test';
import { CALENDAR_PALETTE } from '../color.ts';
import { eventTint } from './eventTint.ts';

// WCAG relative luminance and contrast, written out here so the test does
// not trust the helper it checks.
const linear = (hex: string, index: number): number => {
  const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string): number =>
  linear(hex, 1) * 0.2126 + linear(hex, 3) * 0.7152 + linear(hex, 5) * 0.0722;
const contrast = (a: string, b: string): number => {
  const low = Math.min(luminance(a), luminance(b));
  const high = Math.max(luminance(a), luminance(b));
  return (high + 0.05) / (low + 0.05);
};

describe('eventTint', () => {
  it('keeps text readable on the fill for every Google calendar color, in both schemes', () => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const hex of CALENDAR_PALETTE) {
        const tint = eventTint(hex, scheme);
        expect(contrast(tint.text, tint.fill), `${hex} ${scheme}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('is light on light and dark on dark', () => {
    const light = eventTint('#16a765', 'light');
    const dark = eventTint('#16a765', 'dark');
    expect(luminance(light.fill)).toBeGreaterThan(0.7);
    // Green carries most of the luminance weight, so even a dark green fill is not pitch black.
    expect(luminance(dark.fill)).toBeLessThan(0.1);
    expect(luminance(light.text)).toBeLessThan(luminance(dark.text));
  });

  it('returns lowercase hex and keeps a grey calendar grey', () => {
    const tint = eventTint('#C2C2C2', 'light');
    for (const value of Object.values(tint)) {
      expect(value).toMatch(/^#[\da-f]{6}$/);
    }
    // No chroma was forced in: the fill is a neutral.
    expect(tint.fill.slice(1, 3)).toBe(tint.fill.slice(3, 5));
    expect(tint.fill.slice(3, 5)).toBe(tint.fill.slice(5, 7));
  });

  it('tints an unparsable color like the fallback blue', () => {
    expect(eventTint('not a color', 'light')).toEqual(eventTint('#4285f4', 'light'));
    expect(eventTint('', 'dark')).toEqual(eventTint('#4285f4', 'dark'));
  });
});
