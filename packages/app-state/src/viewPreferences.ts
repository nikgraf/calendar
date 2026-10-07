import { DEFAULT_VIEW_PREFERENCES, type ViewPreferences } from '@calendar/core';
import { useCallback } from 'react';
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
