import {
  DEFAULT_ONBOARDING_STATE,
  type LessonId,
  type LessonMark,
  type OnboardingState,
  setupNeeded,
  withLessonMark,
} from '@calendar/core';
import { useAtomValue } from '@effect/atom-react';
import { AsyncResult } from 'effect/reactivity';
import { useCallback } from 'react';
import { useBackendAtoms, useOnboarding } from './hooks.ts';
import { useGuardedMutations } from './mutationGuard.ts';

/**
 * Some of the onboarding state changed and the rest kept: `setOnboarding`
 * replaces the whole struct, so a caller that only knows its own field
 * (the card's fold, a hide) would wipe the marks. Before the first read
 * resolves the patch lands on the default.
 */
export const mergeOnboarding = (
  current: OnboardingState | null,
  patch: Partial<OnboardingState>,
): OnboardingState => ({ ...(current ?? DEFAULT_ONBOARDING_STATE), ...patch });

export const useUpdateOnboarding = (): ((patch: Partial<OnboardingState>) => Promise<void>) => {
  const current = useOnboarding();
  const { setOnboarding } = useGuardedMutations();
  return useCallback(
    (patch) => setOnboarding(mergeOnboarding(current, patch)),
    [current, setOnboarding],
  );
};

/** Ticks a lesson: tried (`done`) or skipped; a try is never downgraded (`withLessonMark`). */
export const useMarkLesson = (): ((id: LessonId, mark: LessonMark) => Promise<void>) => {
  const current = useOnboarding();
  const { setOnboarding } = useGuardedMutations();
  return useCallback(
    (id, mark) => setOnboarding(withLessonMark(current ?? DEFAULT_ONBOARDING_STATE, id, mark)),
    [current, setOnboarding],
  );
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
