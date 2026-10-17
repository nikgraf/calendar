import type { LanguageModel, ModelAvailability, ModelStatus } from '@calendar/ai';
import { useCallback, useEffect, useRef, useState } from 'react';

/** How often a model the system is still downloading is checked again. */
export const NOT_READY_RECHECK_MS = 30_000;

/** One answered check. */
export interface AvailabilityCheck {
  /** When it answered (epoch ms). */
  readonly at: number;
  readonly availability: ModelAvailability;
  /** Counts the answers: the same answer twice is still two checks, and the UI says so. */
  readonly id: number;
  /** Asked for with Check Again — someone is waiting on it — not a foreground or poll check. */
  readonly manual: boolean;
}

export interface AvailabilityState {
  /** A check is out. */
  readonly checking: boolean;
  /** The last answer, null until the first. */
  readonly last: AvailabilityCheck | null;
  /** The last answer someone asked for: the result line under Check Again. */
  readonly lastManual: AvailabilityCheck | null;
  /** A check someone asked for is out, or waits behind another: Check Again takes no more taps. */
  readonly manualPending: boolean;
}

const IDLE: AvailabilityState = {
  checking: false,
  last: null,
  lastManual: null,
  manualPending: false,
};

/**
 * One check of the model, never a rejection: a check that threw is an
 * answer saying the check failed (`checkError`), which the UI words
 * differently from a model that is unavailable. A model without
 * `availability` (the desktop's, the fixture) answers with its status.
 */
export const readAvailability = async (model: LanguageModel): Promise<ModelAvailability> => {
  try {
    return model.availability ? await model.availability() : { status: await model.status() };
  } catch (error) {
    return {
      checkError: error instanceof Error ? error.message : String(error),
      status: 'unavailable',
    };
  }
};

/**
 * The checks behind `useModelAvailability`, apart from React so their
 * rules are testable:
 * - One check at a time. A request while one is out runs once more after
 *   it — the one out may have started before the user came back from
 *   Settings — and any number of requests meanwhile are that one.
 * - A 'not-ready' model is checked again every 30 s: its download ends
 *   while the app is in front, with no event to wait for.
 * - Nothing lands after `dispose` (unmounted, or the model changed).
 */
export const createAvailabilityChecker = ({
  model,
  now = Date.now,
  onChange,
}: {
  readonly model: LanguageModel;
  readonly now?: () => number;
  readonly onChange: (state: AvailabilityState) => void;
}) => {
  let state = IDLE;
  let out: { readonly manual: boolean } | null = null;
  let queued: { readonly manual: boolean } | null = null;
  let recheck: ReturnType<typeof setTimeout> | undefined;
  let answers = 0;
  let disposed = false;

  const publish = (changes: Partial<AvailabilityState> = {}) => {
    state = {
      ...state,
      ...changes,
      checking: out !== null,
      manualPending: (out?.manual ?? false) || (queued?.manual ?? false),
    };
    onChange(state);
  };

  const start = (manual: boolean) => {
    clearTimeout(recheck);
    out = { manual };
    publish();
    void readAvailability(model).then((availability) => {
      if (disposed) {
        return;
      }
      answers += 1;
      const check: AvailabilityCheck = { at: now(), availability, id: answers, manual };
      out = null;
      if (availability.status === 'not-ready') {
        recheck = setTimeout(() => request(false), NOT_READY_RECHECK_MS);
      }
      const next = queued;
      queued = null;
      publish(manual ? { last: check, lastManual: check } : { last: check });
      if (next) {
        start(next.manual);
      }
    });
  };

  const request = (manual: boolean) => {
    if (disposed) {
      return;
    }
    if (out) {
      queued = { manual: manual || (queued?.manual ?? false) };
      publish();
      return;
    }
    start(manual);
  };

  return {
    dispose: () => {
      disposed = true;
      clearTimeout(recheck);
    },
    getState: () => state,
    request,
  };
};

/**
 * Whether the on-device model can run, with the things the bars need
 * around it: a manual check (Check Again) whose answer is reported even
 * when nothing changed, and a re-check when the app comes back to the
 * foreground — Apple Intelligence is switched on in system settings
 * (leaving the app), model assets download out of process, and the
 * desktop helper restarts with backoff after a crash. A 'not-ready' model
 * is also polled (see `createAvailabilityChecker`).
 *
 * `subscribeForeground` is the platform's "app became active" hook:
 * AppState on iOS, window focus on desktop.
 */
export const useModelAvailability = (
  model: LanguageModel,
  subscribeForeground?: (onActive: () => void) => () => void,
): {
  /** The last answer in full (reason, failed check), null until the first. */
  readonly availability: ModelAvailability | null;
  /** When the last answer came (epoch ms). */
  readonly checkedAt: number | null;
  /** A check is out. */
  readonly checking: boolean;
  /** The last answer to Check Again: its result line and announcement key on its `id`. */
  readonly lastManualCheck: AvailabilityCheck | null;
  /** A check someone asked for is out: Check Again shows "Checking…" and takes no taps. */
  readonly manualChecking: boolean;
  readonly retry: () => void;
  /** null until the first check answers. */
  readonly status: ModelStatus | null;
} => {
  const [state, setState] = useState<AvailabilityState>(IDLE);
  const checker = useRef<ReturnType<typeof createAvailabilityChecker> | null>(null);

  useEffect(() => {
    const current = createAvailabilityChecker({ model, onChange: setState });
    checker.current = current;
    current.request(false);
    const unsubscribe = subscribeForeground?.(() => current.request(false));
    return () => {
      current.dispose();
      unsubscribe?.();
      if (checker.current === current) {
        checker.current = null;
      }
    };
  }, [model, subscribeForeground]);

  const retry = useCallback(() => checker.current?.request(true), []);
  return {
    availability: state.last?.availability ?? null,
    checkedAt: state.last?.at ?? null,
    checking: state.checking,
    lastManualCheck: state.lastManual,
    manualChecking: state.manualPending,
    retry,
    status: state.last?.availability.status ?? null,
  };
};
