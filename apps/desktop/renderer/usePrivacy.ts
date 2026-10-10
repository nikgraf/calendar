import { useEffect, useState } from 'react';
import type { PrivacyState } from './backend.ts';

export type PrivacyChoice = 'hidden' | 'pause10m' | 'visible';

/**
 * The window's screen-capture privacy as the main process holds it, kept
 * current across windows (`privacy:changed`). A 10-minute pause reads as
 * `pause10m` with the minutes it has left, ticking every 30 s. Null until
 * the first read answers.
 */
export function usePrivacy(): {
  readonly active: PrivacyChoice;
  readonly choose: (choice: PrivacyChoice) => void;
  readonly minutesLeft: number;
} | null {
  const [state, setState] = useState<PrivacyState | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The clock only ticks during a pause, so it is reset with every state
  // that arrives: a long-lived window must not count a new pause from an
  // hour-old `now`.
  const receive = (next: PrivacyState) => {
    setNow(Date.now());
    setState(next);
  };

  useEffect(() => {
    let mounted = true;
    void window.calendarBridge.privacyGet().then((current) => {
      if (mounted) {
        receive(current);
      }
    });
    const unsubscribe = window.calendarBridge.onPrivacyChanged(receive);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const paused = state?.visibleUntil !== undefined && state.visibleUntil > now;
  useEffect(() => {
    if (!paused) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [paused]);

  if (!state) {
    return null;
  }
  return {
    active: paused ? 'pause10m' : state.mode,
    choose: (choice) => {
      void window.calendarBridge.privacySet(choice).then(receive);
    },
    minutesLeft: paused ? Math.max(1, Math.ceil((state.visibleUntil! - now) / 60_000)) : 0,
  };
}
