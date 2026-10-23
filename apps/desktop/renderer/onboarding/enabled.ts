import { useEffect, useState } from 'react';

/** Asked once per window: the answer is fixed for the app's lifetime. */
let answer: Promise<boolean> | undefined;

const onboardingEnabled = (): Promise<boolean> => {
  answer ??= window.calendarBridge.onboardingEnabled().catch(() => true);
  return answer;
};

/**
 * Whether the first run and the Getting started card show at all; null
 * until main has answered. Off under `CALENDAR_ONBOARDING=off` (the e2e
 * harness's default), so a seeded profile never meets the setup dialog.
 */
export const useOnboardingEnabled = (): boolean | null => {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let mounted = true;
    void onboardingEnabled().then((value) => {
      if (mounted) {
        setEnabled(value);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);
  return enabled;
};
