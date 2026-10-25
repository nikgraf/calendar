import {
  DEFAULT_VIEW_PREFERENCES,
  DEFAULT_WEEKEND_DAYS,
  shadedWeekdays,
  sortWeekdays,
  type ViewPreferences,
  type Weekday,
} from '@calendar/core';
import { useCallback, useMemo } from 'react';
import { useBackendMutations, useSettingsEditor, useViewPreferences } from './hooks.ts';
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
 * preferences load. A `useSettingsEditor` over just these two: a second
 * tap before the first save is read back builds on the first, and once
 * the saves have landed the stored values show again, so an import or the
 * settings file changing them while the page is open is not overwritten.
 * Every save sends both fields over the other view preferences as last
 * read; a failure is reported through the notice bus.
 */
export const useWeekendEditor = (): WeekendEditor | null => {
  const preferences = useViewPreferences();
  const { setViewPreferences } = useBackendMutations();
  const [current, save] = useSettingsEditor<WeekendChoice, void>(
    preferences && {
      days: sortWeekdays(preferences.weekendDays ?? DEFAULT_WEEKEND_DAYS),
      shading: preferences.weekendShading ?? true,
    },
    (next) =>
      setViewPreferences({
        ...(preferences ?? DEFAULT_VIEW_PREFERENCES),
        weekendDays: [...next.days],
        weekendShading: next.shading,
      }),
  );
  if (!current) {
    return null;
  }
  const change = (next: Partial<WeekendChoice>) =>
    void guardMutation('save the weekend', save)(next);
  return {
    days: current.days,
    setShading: (shading) => change({ shading }),
    shading: current.shading,
    toggleDay: (day) =>
      change({
        days: sortWeekdays(
          current.days.includes(day)
            ? current.days.filter((other) => other !== day)
            : [...current.days, day],
        ),
      }),
  };
};
