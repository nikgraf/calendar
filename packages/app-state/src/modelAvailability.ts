import type { LanguageModel, ModelStatus } from '@calendar/ai';
import { useCallback, useEffect, useState } from 'react';

/** How often a model the system is still downloading is checked again. */
const NOT_READY_RECHECK_MS = 30_000;

/**
 * Whether the on-device model can run, with the things the bars need
 * around it: a manual retry, and a re-check when the app comes back to
 * the foreground — Apple Intelligence is switched on in system settings
 * (leaving the app), model assets download out of process, and the
 * desktop helper restarts with backoff after a crash. The iOS bar had all
 * of this; ⌘K checked once at mount and stayed "unavailable" until it
 * was reopened. A 'not-ready' model is also polled: its download ends
 * while the app is in front, with no event to wait for.
 *
 * `subscribeForeground` is the platform's "app became active" hook:
 * AppState on iOS, window focus on desktop.
 */
export const useModelAvailability = (
  model: LanguageModel,
  subscribeForeground?: (onActive: () => void) => () => void,
): {
  readonly checking: boolean;
  readonly retry: () => void;
  /** null until the first check answers. */
  readonly status: ModelStatus | null;
} => {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let recheck: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(recheck);
      setChecking(true);
      void model
        .status()
        .then((value) => {
          if (!cancelled) {
            setStatus(value);
            if (value === 'not-ready') {
              // Overlapping checks (focus during a poll) keep one timer.
              clearTimeout(recheck);
              recheck = setTimeout(check, NOT_READY_RECHECK_MS);
            }
          }
        })
        .finally(() => {
          if (!cancelled) {
            setChecking(false);
          }
        });
    };
    check();
    const unsubscribe = subscribeForeground?.(check);
    return () => {
      cancelled = true;
      clearTimeout(recheck);
      unsubscribe?.();
    };
  }, [attempt, model, subscribeForeground]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  return { checking, retry, status };
};
