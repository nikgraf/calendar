import {
  DEFAULT_VIEW_PREFERENCES,
  DEFAULT_WEEKEND_DAYS,
  shadedWeekdays,
  sortWeekdays,
  type ViewPreferences,
  type Weekday,
} from '@calendar/core';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useBackendMutations, useViewPreferences } from './hooks.ts';
import { guardMutation, useGuardedMutations } from './mutationGuard.ts';

/**
 * Changes some view preferences and keeps the rest: `setViewPreferences`
 * replaces the whole struct, so a caller that only knows about its own
 * field would wipe the others. Before the first read resolves the patch
 * lands on the defaults.
 */
export const useUpdateViewPreferences = (): ((patch: Partial<ViewPreferences>) => void) => {
  const current = useViewPreferences();
  const { setViewPreferences } = useGuardedMutations();
  return useCallback(
    (patch) => {
      void setViewPreferences({ ...(current ?? DEFAULT_VIEW_PREFERENCES), ...patch });
    },
    [current, setViewPreferences],
  );
};

const NO_DAYS: ReadonlySet<Weekday> = new Set();

/**
 * The weekdays the grids shade. None until the preferences load, so a
 * device that turned shading off never flashes the default weekend.
 */
export const useShadedWeekdays = (): ReadonlySet<Weekday> => {
  const preferences = useViewPreferences();
  return useMemo(() => (preferences ? shadedWeekdays(preferences) : NO_DAYS), [preferences]);
};

interface WeekendChoice {
  readonly days: ReadonlyArray<Weekday>;
  readonly shading: boolean;
}

/** The weekend as Settings › Calendar edits it. */
export interface WeekendEditor extends WeekendChoice {
  readonly setShading: (shading: boolean) => void;
  readonly toggleDay: (day: Weekday) => void;
}

/**
 * The weekend fields as Settings › Calendar edits them; null until the
 * preferences load. A change builds on the last one sent, not on the last
 * read, so a second tap before the first save is read back keeps the
 * first (the page is these fields' only writer while it is open, as with
 * `useSettingsEditor`). Every save sends both fields, over the other view
 * preferences as last read; a failed one shows the stored values again.
 */
export const useWeekendEditor = (): WeekendEditor | null => {
  const preferences = useViewPreferences();
  const { setViewPreferences } = useBackendMutations();
  const [sent, setSent] = useState<WeekendChoice | null>(null);
  // Read by the handlers: two taps inside one frame chain too.
  const latest = useRef<WeekendChoice | null>(null);
  if (!preferences) {
    return null;
  }
  const current = sent ?? {
    days: preferences.weekendDays ?? DEFAULT_WEEKEND_DAYS,
    shading: preferences.weekendShading ?? true,
  };
  const save = (change: Partial<WeekendChoice>) => {
    const next = { ...(latest.current ?? current), ...change };
    latest.current = next;
    setSent(next);
    void guardMutation('save the weekend', (payload: ViewPreferences) =>
      setViewPreferences(payload).catch((error: unknown) => {
        latest.current = null;
        setSent(null);
        throw error;
      }),
    )({ ...preferences, weekendDays: sortWeekdays(next.days), weekendShading: next.shading });
  };
  return {
    days: current.days,
    setShading: (shading) => save({ shading }),
    shading: current.shading,
    toggleDay: (day) => {
      const { days } = latest.current ?? current;
      save({ days: days.includes(day) ? days.filter((other) => other !== day) : [...days, day] });
    },
  };
};
