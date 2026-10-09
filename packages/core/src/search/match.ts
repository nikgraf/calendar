import type { EventRecord, TaskRecord } from '../types.ts';

/**
 * Text as search compares it: decomposed (NFD) with the combining marks
 * dropped, so "é" reads as "e", then lowercased without a locale — "Café",
 * "CAFE" and "cafe" fold to the same text on every device.
 */
export const foldSearchText = (text: string): string =>
  text.normalize('NFD').replaceAll(/\p{M}/gu, '').toLowerCase();

/** The folded words of a query. A blank query has none and matches nothing. */
export const searchTerms = (query: string): ReadonlyArray<string> =>
  foldSearchText(query)
    .split(/\s+/u)
    .filter((term) => term !== '');

/**
 * Every term occurs in one of the fields. The fields are joined by a line
 * break, which no term contains (terms are split on whitespace), so a term
 * never matches across two of them.
 */
const matchesEvery = (
  terms: ReadonlyArray<string>,
  fields: ReadonlyArray<string | undefined>,
): boolean => {
  if (terms.length === 0) {
    return false;
  }
  const text = fields
    .filter((field): field is string => field !== undefined && field !== '')
    .map(foldSearchText)
    .join('\n');
  return terms.every((term) => text.includes(term));
};

/** Every term is in the event's title, place, notes, or a guest's name or address. */
export const eventMatchesSearch = (
  event: Pick<EventRecord, 'attendees' | 'description' | 'location' | 'title'>,
  terms: ReadonlyArray<string>,
): boolean =>
  matchesEvery(terms, [
    event.title,
    event.location,
    event.description,
    ...(event.attendees ?? []).flatMap((attendee) => [attendee.displayName, attendee.email]),
  ]);

/** Every term is in the task's title or notes. */
export const taskMatchesSearch = (
  task: Pick<TaskRecord, 'notes' | 'title'>,
  terms: ReadonlyArray<string>,
): boolean => matchesEvery(terms, [task.title, task.notes]);
