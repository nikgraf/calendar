import { describe, expect, it } from 'vite-plus/test';
import { popoverTop } from './popoverPlacement.ts';

describe('popoverTop', () => {
  it('opens under the opener when the panel fits', () => {
    expect(popoverTop({ above: 96, y: 124 }, 142, 560)).toBe(124);
    // Touching the margin still fits.
    expect(popoverTop({ y: 410 }, 142, 560)).toBe(410);
  });

  it('opens above the opener when there is no room under it', () => {
    // A low row in the 560 px settings window: 536 + 142 would end at 678.
    expect(popoverTop({ above: 504, y: 536 }, 142, 560)).toBe(362);
  });

  it('stays inside the window when it fits neither under nor above', () => {
    expect(popoverTop({ above: 100, y: 128 }, 500, 560)).toBe(52);
    // No opener top given: as low as the window allows.
    expect(popoverTop({ y: 536 }, 142, 560)).toBe(410);
  });

  it('keeps the top margin when the panel is taller than the window', () => {
    expect(popoverTop({ above: 300, y: 328 }, 700, 560)).toBe(8);
  });
});
