import { bufferedRange, monthGridRange, Temporal, type UtcRange, weekStart } from '@calendar/core';
import { useCallback, useMemo, useState } from 'react';

export type CalendarViewKind = 'day' | 'month' | 'week';

export interface CalendarNavigationOptions {
  /** Buffer days fetched on each side of the visible day/week strip. */
  readonly dayBuffer: number;
  readonly initialView: CalendarViewKind;
  readonly timeZone: string;
  /** Desktop shows the long form ("Thursday, September 10, 2026"); iOS the compact one. */
  readonly titleStyle: 'compact' | 'long';
}

const titleFor = (
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
  const end = windowStart.add({ days: 6 });
  return windowStart.month === end.month
    ? `${windowStart.toLocaleString('en-US', { month: 'long' })} ${windowStart.day} – ${end.day}, ${windowStart.year}`
    : `${windowStart.toLocaleString('en-US', { day: 'numeric', month: 'short' })} – ${end.toLocaleString('en-US', { day: 'numeric', month: 'short' })}, ${end.year}`;
};

/**
 * View + focused day + the week window, and everything derived from them:
 * the fetch range, the visible days, the header title, stepping, panning
 * and the Today reset. Both apps carried this block; the week view's
 * rolling window (only wheel/swipe navigation sets it; Today and view
 * switches snap back to the Monday week) is the same on both.
 */
export const useCalendarNavigation = ({
  dayBuffer,
  initialView,
  timeZone,
  titleStyle,
}: CalendarNavigationOptions) => {
  const [view, setView] = useState<CalendarViewKind>(initialView);
  const [focused, setFocused] = useState(() => Temporal.Now.plainDateISO(timeZone));
  const [weekWindowStart, setWeekWindowStart] = useState<Temporal.PlainDate | null>(null);

  const windowStart = useMemo(
    () => weekWindowStart ?? weekStart(focused),
    [weekWindowStart, focused],
  );

  const range: UtcRange = useMemo(() => {
    switch (view) {
      case 'day':
        return bufferedRange(focused, 1, dayBuffer, timeZone);
      case 'month':
        return monthGridRange(
          Temporal.PlainYearMonth.from(focused),
          Temporal.Now.plainDateISO(timeZone),
          timeZone,
        );
      case 'week':
        return bufferedRange(windowStart, 7, dayBuffer, timeZone);
    }
  }, [view, focused, windowStart, dayBuffer, timeZone]);

  const days = useMemo(
    () =>
      view === 'day'
        ? [focused]
        : Array.from({ length: 7 }, (_, index) => windowStart.add({ days: index })),
    [view, focused, windowStart],
  );

  // Stable per (view, windowStart, timeZone): the apps hang these on
  // keyboard and app-state listeners.
  const step = useCallback(
    (direction: 1 | -1) => {
      setFocused((current) =>
        view === 'month'
          ? current.add({ months: direction })
          : current.add({ days: direction * (view === 'week' ? 7 : 1) }),
      );
      if (view === 'week') {
        setWeekWindowStart((current) => current?.add({ days: 7 * direction }) ?? null);
      }
    },
    [view],
  );

  /** Pan commits: whole days crossed by a wheel pan or a swipe. */
  const panByDays = useCallback(
    (dayCount: number) => {
      if (view === 'week') {
        setWeekWindowStart(windowStart.add({ days: dayCount }));
      }
      setFocused((current) => current.add({ days: dayCount }));
    },
    [view, windowStart],
  );

  const switchView = useCallback((kind: CalendarViewKind) => {
    setWeekWindowStart(null);
    setView(kind);
  }, []);

  const goToday = useCallback(() => {
    setFocused(Temporal.Now.plainDateISO(timeZone));
    setWeekWindowStart(null);
  }, [timeZone]);

  return {
    days,
    focused,
    goToday,
    panByDays,
    range,
    setFocused,
    step,
    switchView,
    title: titleFor(view, focused, windowStart, titleStyle),
    view,
    windowStart,
  };
};
