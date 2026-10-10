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
 * The days a slide to a picked first day draws beyond the visible ones:
 * `lead` before them, `trail` after. A slide comes from the days on screen,
 * so the strip holds them too; while a slide is still under way they can be
 * anywhere in its span, so the next one keeps covering all of it.
 */
export interface Slide {
  readonly lead: number;
  readonly trail: number;
}

export const NO_SLIDE: Slide = { lead: 0, trail: 0 };

export const isSliding = (slide: Slide): boolean => slide.lead + slide.trail > 0;

/**
 * The slide to a first day `shift` days from the current one, given the
 * slide (if any) still under way: the whole way up to two windows on each
 * side, so a nearby pick slides on from exactly the days on screen; a
 * farther one starts that far short of its target instead of drawing every
 * day in between.
 */
export const nextSlide = (current: Slide, shift: number, visibleCount: number): Slide => {
  const cap = 2 * visibleCount;
  return {
    lead: Math.min(Math.max(current.lead + shift, 0), cap),
    trail: Math.min(Math.max(current.trail - shift, 0), cap),
  };
};

/**
 * The visible days plus a slide's extra days on each side: what the strip
 * draws and the range fetches until the slide ends. No slide, just the
 * visible days.
 */
export const slideSpan = (
  firstVisible: Temporal.PlainDate,
  visibleCount: number,
  slide: Slide,
): { readonly count: number; readonly first: Temporal.PlainDate } => ({
  count: visibleCount + slide.lead + slide.trail,
  first: firstVisible.subtract({ days: slide.lead }),
});

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
