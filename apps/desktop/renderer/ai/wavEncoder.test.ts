import { describe, expect, it } from 'vitest';
import { encodeWav } from './wavEncoder.ts';

describe('encodeWav', () => {
  it('writes a valid 16-bit mono RIFF header and clamps samples', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2, -2]), 16_000);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(10); // 5 samples × 2 bytes
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(0x7f_ff);
    expect(view.getInt16(48, true)).toBe(-0x80_00);
    // Out-of-range input clamps instead of wrapping.
    expect(view.getInt16(50, true)).toBe(0x7f_ff);
    expect(view.getInt16(52, true)).toBe(-0x80_00);
  });
});
