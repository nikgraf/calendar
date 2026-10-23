import { type LessonId, type LessonMark, type OnboardingChange, setupNeeded } from '@calendar/core';
import { useAtomValue } from '@effect/atom-react';
import { AsyncResult } from 'effect/reactivity';
import { useCallback } from 'react';
import { useBackendAtoms, useOnboarding } from './hooks.ts';
import { useGuardedMutations } from './mutationGuard.ts';

/**
 * Changes the onboarding state by what changes — the card's fold, the
 * setup's outcome, Start Over — applied by the backend to what is stored,
 * so a window that has not read the last change back yet never undoes it.
 */
export const useUpdateOnboarding = (): ((change: OnboardingChange) => Promise<void>) =>
  useGuardedMutations().updateOnboarding;

/** Ticks a lesson: tried (`done`) or skipped; a try is never downgraded (`withLessonMark`). */
export const useMarkLesson = (): ((id: LessonId, mark: LessonMark) => Promise<void>) => {
  const update = useUpdateOnboarding();
  return useCallback((id, mark) => update({ lesson: { id, mark } }), [update]);
};

/**
 * How many accounts are connected, or null until the first read: the
 * accounts' empty fallback while loading would read as "nothing
 * connected" (the card's "Add your accounts" row for a beat).
 */
export const useAccountCount = (): number | null => {
  const accounts = useAtomValue(useBackendAtoms().accounts);
  return AsyncResult.isSuccess(accounts) ? accounts.value.length : null;
};

/**
 * Whether the first run is due: nothing connected and the setup never
 * finished or skipped. Null until both the accounts and the state have
 * been read — the accounts' empty fallback while loading would otherwise
 * read as "nothing connected" and open the setup on every launch for a
 * beat.
 */
export const useSetupNeeded = (): boolean | null => {
  const accountCount = useAccountCount();
  const state = useOnboarding();
  return state === null || accountCount === null ? null : setupNeeded(state, accountCount);
};
