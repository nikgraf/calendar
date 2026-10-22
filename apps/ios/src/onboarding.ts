import { useSyncExternalStore } from 'react';

/**
 * `EXPO_PUBLIC_CALENDAR_ONBOARDING=off` (the CI bundle): no first run and
 * no Getting started card, whatever the stored state says — the Maestro
 * flows start on the calendar. Inlined by Metro at bundle time, like the
 * Google and model switches.
 */
const envEnabled = process.env['EXPO_PUBLIC_CALENDAR_ONBOARDING'] !== 'off';

/**
 * The onboarding flow's own switch: the `onboarding-fixture` deep link
 * (fixture builds only, EditorHost.tsx) turns onboarding on for the rest
 * of this launch, so the flow walks the setup and meets the card under
 * the bundle that keeps both off for every other flow.
 */
let forced = false;
const listeners = new Set<() => void>();

export const forceOnboarding = (): void => {
  forced = true;
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Whether the first run and the Getting started card show at all. */
export const useOnboardingEnabled = (): boolean =>
  useSyncExternalStore(subscribe, () => envEnabled || forced);
