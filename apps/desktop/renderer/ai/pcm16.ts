/**
 * Float32 samples → 16-bit little-endian PCM: the blocks dictation streams
 * to the helper (16 kHz mono, SpeechAnalyzer's own format).
 */
export const toPcm16 = (samples: Float32Array): Uint8Array => {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x80_00 : clamped * 0x7f_ff, true);
  }
  return new Uint8Array(view.buffer);
};
