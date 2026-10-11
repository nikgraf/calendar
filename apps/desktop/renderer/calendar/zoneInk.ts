/**
 * Each zone's text color by its place in the list, primary first: the same
 * in the hour gutter, its city header, the inspector and the editor, so a
 * shade says which zone a time belongs to. Only drawn while there is more
 * than one zone; a lone primary keeps the gutter's secondary ink.
 */
const ZONE_INK = ['text-ink', 'text-ink-secondary', 'text-ink-tertiary'] as const;

export const zoneInk = (index: number): string => ZONE_INK[Math.min(index, ZONE_INK.length - 1)]!;
