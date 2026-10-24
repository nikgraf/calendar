import { useIsFocused } from 'expo-router';
import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';

/**
 * A settings code that arrived from outside a reader — shared into the
 * app as text, opened from the Camera app's "Open in Solunivo" (the code
 * parses as a `solunivo:` URL), or the e2e flows' `capture-fixture` link —
 * held until a reader takes it. Where it goes depends on the first run:
 *
 * - a reader is on screen (the setup's copy step, Settings › Read Code):
 *   it takes the code;
 * - the setup is up: its copy step, which is a reader;
 * - the setup is due but not up yet (a cold start from the Camera app on
 *   a fresh install): nothing yet — the welcome forwards to the copy step
 *   when it opens;
 * - otherwise: Settings › Settings File › Read Code.
 */
interface Router {
  readonly push: (href: '/settings/read-code' | '/setup/copy') => void;
}

type SetupPhase = 'closed' | 'open' | 'opening' | 'unknown';

let pending: string | null = null;
let readers = 0;
let setup: SetupPhase = 'unknown';
const listeners = new Set<() => void>();

const notify = () => {
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

const route = (router: Router) => {
  if (pending === null || readers > 0) {
    return;
  }
  if (setup === 'open') {
    router.push('/setup/copy');
  } else if (setup === 'closed') {
    router.push('/settings/read-code');
  }
};

/** A code from outside: kept, and the right reader brought up. */
export const deliverSettingsCode = (code: string, router: Router): void => {
  pending = code;
  notify();
  route(router);
};

/**
 * The first run's progress, from CalendarScreen (decided: due or not) and
 * the setup's layout (mounted, unmounted). Once the setup is out of the
 * way, a waiting code goes to Settings.
 */
export const setSetupPhase = (phase: SetupPhase, router?: Router): void => {
  if (setup === phase) {
    return;
  }
  setup = phase;
  if (phase === 'closed' && router) {
    route(router);
  }
};

/**
 * Whether the setup is up or on its way: a share that opens the app then
 * must not move the router, or its `/` would dismiss the setup whose copy
 * step is about to read it (`+native-intent.tsx`).
 */
export const setupIsUp = (): boolean => setup === 'open' || setup === 'opening';

/**
 * Whether a code waits for a reader. The setup's welcome asks once, on
 * mount: a code that came before the setup was up goes to the copy step;
 * one that comes later is routed here (`route`), never by the welcome too.
 */
export const settingsCodeWaiting = (): boolean => pending !== null;

/**
 * A reader's side: registered while its screen is in front, so a code
 * that arrives goes to it rather than to a new screen; `onCode` hears the
 * waiting code (now, or when it arrives), which is then gone from the
 * inbox. A stack keeps the screens under the top one mounted (the copy
 * step under the copied one, under "Set up by hand"): those neither count
 * as a reader nor take a code.
 */
export const useSettingsCodeReader = (onCode: (code: string) => void): void => {
  const focused = useIsFocused();
  const code = useSyncExternalStore(subscribe, () => pending);
  const take = useEffectEvent((value: string) => onCode(value));
  useEffect(() => {
    if (!focused) {
      return;
    }
    readers += 1;
    return () => {
      readers -= 1;
    };
  }, [focused]);
  useEffect(() => {
    // Still waiting: two readers that rendered the same code take it once.
    if (focused && code !== null && pending === code) {
      pending = null;
      notify();
      take(code);
    }
  }, [code, focused]);
};
