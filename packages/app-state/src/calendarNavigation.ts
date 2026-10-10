import {
  bufferedRange,
  type CalendarViewKind,
  clampSlide,
  monthGridRange,
  slideSpan,
  Temporal,
  type UtcRange,
  weekStart,
} from '@calendar/core';
import { useCallback, useMemo, useState } from 'react';

export type { CalendarViewKind } from '@calendar/core';

/** Days the agenda lists from the focused day on. */
export const AGENDA_DAYS = 14;

/** Timeline columns a view draws; the month grid and the agenda list have none. */
export const viewColumns = (view: CalendarViewKind): number => {
  switch (view) {
    case 'agenda':
    case 'month':
      return 0;
    case 'day':
      return 1;
    case 'twoDay':
      return 2;
    case 'week':
      return 7;
  }
};

/** Days a view covers from its window start: its columns, or the agenda's two weeks. */
const visibleDays = (view: CalendarViewKind): number =>
  view === 'agenda' ? AGENDA_DAYS : viewColumns(view);

export interface CalendarNavigationOptions {
  /** Buffer days fetched on each side of the visible day/week strip. */
  readonly dayBuffer: number;
  readonly initialView: CalendarViewKind;
  readonly timeZone: string;
  /** Desktop shows the long form ("Thursday, September 10, 2026"); iOS the compact one. */
  readonly titleStyle: 'compact' | 'long';
  /** Buffer for the two-day strip; defaults to `dayBuffer`. iOS needs two so a full-page drag commits both columns. */
  readonly twoDayBuffer?: number;
  /**
   * Buffer for the week strip; defaults to `dayBuffer`. Desktop pans the
   * week by single days, iOS pages by whole weeks and needs seven.
   */
  readonly weekBuffer?: number;
}

export const titleFor = (
  view: CalendarViewKind,
  focused: Temporal.PlainDate,
  windowStart: Temporal.PlainDate,
  style: CalendarNavigationOptions['titleStyle'],
): string => {
  if (view === 'month') {
    return focused.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  }
  if (view === 'day') {
    return style === 'long'
      ? focused.toLocaleString('en-US', {
          day: 'numeric',
          month: 'long',
          weekday: 'long',
          year: 'numeric',
        })
      : focused.toLocaleString('en-US', { day: 'numeric', month: 'long', weekday: 'short' });
  }
  const end = windowStart.add({ days: visibleDays(view) - 1 });
  // "September 7 – 13, 2026" on desktop; the phone header truncates the
  // long month, so compact uses "Sep 7 – 13, 2026".
  const month = style === 'long' ? 'long' : 'short';
  return windowStart.month === end.month
    ? `${windowStart.toLocaleString('en-US', { month })} ${windowStart.day} – ${end.day}, ${windowStart.year}`
    : `${windowStart.toLocaleString('en-US', { day: 'numeric', month: 'short' })} – ${end.toLocaleString('en-US', { day: 'numeric', month: 'short' })}, ${end.year}`;
};

/**
 * View + focused day + the week window, and everything derived from them:
 * the fetch range, the visible days, the header title, stepping, panning
 * and the Today reset. Both apps carried this block; the week view's
 * rolling window (only wheel/swipe navigation and a picked day set it;
 * Today and view switches snap back to the Monday week) is the same on
 * both. The day
 * and two-day views anchor on the focused day itself, so they need no
 * window state: the focused day is the first column. A picked day
 * (`scrollToDay`) leads the strip instead, and `slide` holds the days the
 * view slides across to it until the view calls `endSlide`.
 */
export const useCalendarNavigation = ({
  dayBuffer,
  initialView,
  timeZone,
  titleStyle,
  twoDayBuffer,
  weekBuffer,
}: CalendarNavigationOptions) => {
  const [view, setView] = useState<CalendarViewKind>(initialView);
  const [focused, setFocused] = useState(() => Temporal.Now.plainDateISO(timeZone));
  const [weekWindowStart, setWeekWindowStart] = useState<Temporal.PlainDate | null>(null);
  // Signed days a slide to a picked first day travels (0: none). Every
  // other navigation clears it, so a first day that changes while it is
  // set is that slide's, never a jump's.
  const [slide, setSlide] = useState(0);

  const windowStart = useMemo(
    () => (view === 'week' ? (weekWindowStart ?? weekStart(focused)) : focused),
    [view, weekWindowStart, focused],
  );

  // The agenda is a list, not a strip: nothing pans, so nothing is buffered.
  const buffer =
    view === 'week'
      ? (weekBuffer ?? dayBuffer)
      : view === 'twoDay'
        ? (twoDayBuffer ?? dayBuffer)
        : view === 'agenda'
          ? 0
          : dayBuffer;
  const dayCount = visibleDays(view);

  const range: UtcRange = useMemo(() => {
    if (view === 'month') {
      return monthGridRange(
        Temporal.PlainYearMonth.from(focused),
        Temporal.Now.plainDateISO(timeZone),
        timeZone,
      );
    }
    // A slide draws the days it travels across too.
    const span = slideSpan(windowStart, dayCount, slide);
    return bufferedRange(span.first, span.count, buffer, timeZone);
  }, [view, focused, windowStart, dayCount, slide, buffer, timeZone]);

  const days = useMemo(
    () => Array.from({ length: dayCount }, (_, index) => windowStart.add({ days: index })),
    [dayCount, windowStart],
  );

  // Stable per (view, windowStart, timeZone): the apps hang these on
  // keyboard and app-state listeners.
  const step = useCallback(
    (direction: 1 | -1) => {
      setFocused((current) =>
        view === 'month'
          ? current.add({ months: direction })
          : current.add({ days: direction * dayCount }),
      );
      if (view === 'week') {
        setWeekWindowStart((current) => current?.add({ days: 7 * direction }) ?? null);
      }
      setSlide(0);
    },
    [view, dayCount],
  );

  /**
   * Pan commits: whole days crossed by a wheel pan or a swipe. Two can
   * land before a render (a swipe that takes over the previous one's
   * commit), so both updates build on the current state.
   */
  const panByDays = useCallback(
    (dayCount: number) => {
      if (view === 'week') {
        setWeekWindowStart((current) => (current ?? windowStart).add({ days: dayCount }));
      }
      setFocused((current) => current.add({ days: dayCount }));
      setSlide(0);
    },
    [view, windowStart],
  );

  const switchView = useCallback((kind: CalendarViewKind) => {
    setWeekWindowStart(null);
    setSlide(0);
    setView(kind);
  }, []);

  const goToday = useCallback(() => {
    setFocused(Temporal.Now.plainDateISO(timeZone));
    setWeekWindowStart(null);
    setSlide(0);
  }, [timeZone]);

  /**
   * Shows a given day: it becomes the focused day, and the week view drops
   * a window a pan rolled, which would otherwise go on showing its own
   * days, for the week holding it — what Today does for today.
   * `setFocused` alone moves the focus within the days on screen.
   */
  const goToDay = useCallback((date: Temporal.PlainDate) => {
    setFocused(date);
    setWeekWindowStart(null);
    setSlide(0);
  }, []);

  /**
   * A day picked to lead the strip (the desktop's mini month): it becomes
   * the first column — in the week view a window rolled to start there,
   * like a pan's — and `slide` tells the view how far to slide to it. The
   * month view just shows the day's month.
   */
  const scrollToDay = useCallback(
    (date: Temporal.PlainDate) => {
      if (view === 'month') {
        goToDay(date);
        return;
      }
      setFocused(date);
      const shift = windowStart.until(date).days;
      if (shift === 0) {
        return;
      }
      if (view === 'week') {
        setWeekWindowStart(date);
      }
      setSlide(clampSlide(shift, dayCount));
    },
    [view, windowStart, dayCount, goToDay],
  );

  /** The view finished sliding: the strip and the range drop the days it crossed. */
  const endSlide = useCallback(() => setSlide(0), []);

  return {
    /** Neighbour days drawn on each side of `days` (matches `range`). */
    buffer,
    days,
    endSlide,
    focused,
    goToDay,
    goToday,
    panByDays,
    range,
    scrollToDay,
    setFocused,
    /** Signed days the view is sliding across to a picked first day (0: none). */
    slide,
    step,
    switchView,
    title: titleFor(view, focused, windowStart, titleStyle),
    view,
    windowStart,
  };
};
