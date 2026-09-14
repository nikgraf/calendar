import type { BirthdayOccurrence } from '../types.ts';

/**
 * Chip text for the all-day lane: the cake is the kind marker (birthdays
 * carry no calendar color), the age follows when the birth year is known.
 * Both platforms render this string so the lane reads the same everywhere.
 */
export const birthdayChipLabel = (
  occurrence: Pick<BirthdayOccurrence, 'age'> & {
    readonly record: { readonly displayName: string };
  },
): string =>
  occurrence.age === undefined
    ? `🎂 ${occurrence.record.displayName}`
    : `🎂 ${occurrence.record.displayName} (${String(occurrence.age)})`;
