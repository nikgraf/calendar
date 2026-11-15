/** A block of samples' level in dBFS (RMS); -Infinity for digital silence. */
export const levelOf = (samples: ArrayLike<number>): number => {
  if (samples.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    sum += sample * sample;
  }
  return 10 * Math.log10(sum / samples.length);
};
