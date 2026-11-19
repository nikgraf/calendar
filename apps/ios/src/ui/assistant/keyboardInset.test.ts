import { describe, expect, it } from 'vite-plus/test';
import { keyboardOverlap } from './keyboardInset.ts';

describe('keyboardOverlap', () => {
  it('is the keyboard’s height while it is up', () => {
    expect(keyboardOverlap(508, 844)).toBe(336);
  });

  it('is nothing while the keyboard is at or below the window’s bottom edge', () => {
    expect(keyboardOverlap(844, 844)).toBe(0);
    expect(keyboardOverlap(900, 844)).toBe(0);
  });

  it('never exceeds the window', () => {
    expect(keyboardOverlap(-20, 844)).toBe(844);
  });
});
