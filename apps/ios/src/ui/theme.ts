export const palette = {
  background: '#fafafa',
  border: '#e5e5e5',
  gridLine: '#f0f0f0',
  text: '#171717',
  textFaint: '#a3a3a3',
  textMuted: '#737373',
  today: '#ef4444',
};

/** Readable foreground for chips on a calendar-colored background. */
export const chipTextColor = (backgroundHex: string): string => {
  const hex = backgroundHex.replace('#', '');
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return 0.299 * red + 0.587 * green + 0.114 * blue > 160 ? '#1f2937' : '#ffffff';
};
