import {
  DEFAULT_VIEW_PREFERENCES,
  shadedWeekdays,
  type ViewPreferences,
  type Weekday,
} from '@calendar/core';
import { useCallback, useMemo } from 'react';
import { useViewPreferences } from './hooks.ts';
import { useGuardedMutations } from './mutationGuard.ts';

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
