import type { Temporal } from '../time/temporal.ts';

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Accessible name of a month cell, the same on both platforms: the long
 * date, then the non-zero counts in the cell's display order (events,
 * birthdays, tasks) — "Tuesday, September 15, 2 events, 1 task" — or
 * "nothing scheduled".
 */
export const monthCellLabel = (
  date: Temporal.PlainDate,
  counts: { readonly birthdays: number; readonly events: number; readonly tasks: number },
): string => {
  const parts = [
    counts.events > 0 ? plural(counts.events, 'event') : null,
    counts.birthdays > 0 ? plural(counts.birthdays, 'birthday') : null,
    counts.tasks > 0 ? plural(counts.tasks, 'task') : null,
  ].filter((part) => part !== null);
  const day = date.toLocaleString('en-US', { day: 'numeric', month: 'long', weekday: 'long' });
  return `${day}, ${parts.length > 0 ? parts.join(', ') : 'nothing scheduled'}`;
};
