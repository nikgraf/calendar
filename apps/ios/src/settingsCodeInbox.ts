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
  readonly push: (
    href: '/settings/read-code' | '/setup/copy',
    options?: { readonly withAnchor?: boolean },
  ) => void;
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

type Href = Parameters<Router['push']>[0];

const route = (router: Router): Href | null => {
  if (pending === null || readers > 0) {
    return null;
  }
  const href = setup === 'open' ? '/setup/copy' : setup === 'closed' ? '/settings/read-code' : null;
  if (href === '/settings/read-code') {
    // From outside Settings: its root goes under the page, so Back leads
    // to it (and its Done closes Settings) instead of a lone page.
    router.push(href, { withAnchor: true });
  } else if (href) {
    router.push(href);
  }
  return href;
};

/**
 * A code from outside: kept, and the right reader brought up. Answers the
 * screen it pushed, if any (the host holds a capture's thread while
 * Settings is on its way).
 */
export const deliverSettingsCode = (code: string, router: Router): Href | null => {
  pending = code;
  notify();
  return route(router);
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
 * Whether a share that opens the app now may well be a code for a reader:
 * the setup is up or on its way, or a reader is in front (Settings › Read
 * Code). Then a share must not move the router (`+native-intent.tsx`): its
 * `/` would dismiss the screen that is about to read it, and could leave
 * the code waiting with nothing to route it.
 */
export const awaitingCode = (): boolean => setup === 'open' || setup === 'opening' || readers > 0;

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
