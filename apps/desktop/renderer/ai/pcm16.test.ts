import { describe, expect, it } from 'vite-plus/test';
import { toPcm16 } from './pcm16.ts';

describe('toPcm16', () => {
  it('writes 16-bit little-endian samples and clamps them', () => {
    const pcm = toPcm16(new Float32Array([0, 1, -1, 2, -2]));
    const view = new DataView(pcm.buffer);
    expect(pcm.byteLength).toBe(10);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(0x7f_ff);
    expect(view.getInt16(4, true)).toBe(-0x80_00);
    // Out-of-range input clamps instead of wrapping.
    expect(view.getInt16(6, true)).toBe(0x7f_ff);
    expect(view.getInt16(8, true)).toBe(-0x80_00);
  });
});
