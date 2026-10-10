/** Neighbour days the mobile day view keeps drawn on each side. */
export const DAY_SWIPE_BUFFER = 1;
/** The mobile two-day view: a full-page drag reveals two drawn columns. */
export const TWO_DAY_SWIPE_BUFFER = 2;
/** The mobile week view pages by whole weeks, so a full week sits on each side. */
export const WEEK_SWIPE_BUFFER = 7;

import { daySpanRange, type UtcRange } from '../time/ranges.ts';
import { Temporal } from '../time/temporal.ts';

/**
 * The days a panning strip renders: the visible days plus `buffer`
 * neighbours on each side, so a gesture reveals drawn content.
 */
export const bufferedDays = (
  firstVisible: Temporal.PlainDate,
  visibleCount: number,
  buffer: number,
): Array<Temporal.PlainDate> =>
  Array.from({ length: visibleCount + 2 * buffer }, (_, index) =>
    firstVisible.add({ days: index - buffer }),
  );

/**
 * The fetch window covering those same days. Deriving it here keeps the
 * range and the rendered strip from drifting apart.
 */
export const bufferedRange = (
  firstVisible: Temporal.PlainDate,
  visibleCount: number,
  buffer: number,
  timeZone: string,
): UtcRange =>
  daySpanRange(firstVisible.subtract({ days: buffer }), visibleCount + 2 * buffer, timeZone);

/**
 * The largest of each run of `pageSize` consecutive values: per page the
 * strip can show, first page first, what its busiest day needs (the
 * all-day lane's rows). A strip of `visibleCount + 2 * buffer` days holds
 * `2 * buffer + 1` pages, the visible one in the middle.
 */
export const pageMaxima = (values: ReadonlyArray<number>, pageSize: number): Array<number> =>
  Array.from({ length: Math.max(values.length - pageSize + 1, 0) }, (_, start) =>
    Math.max(...values.slice(start, start + pageSize)),
  );
