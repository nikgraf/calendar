import type { Account, BackendClient, CalendarInfo, EventRecord } from '@calendar/core';
import { Effect } from 'effect';
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

export interface BackendContextValue {
  readonly client: BackendClient;
  /** Data-change subscription; returns an unsubscribe function. */
  readonly onChanged?: ((listener: () => void) => () => void) | undefined;
}

const BackendContext = createContext<BackendContextValue | null>(null);

export const BackendProvider = ({
  children,
  value,
}: {
  children: ReactNode;
  value: BackendContextValue;
}) => createElement(BackendContext.Provider, { value }, children);

export const useBackend = (): BackendContextValue => {
  const context = useContext(BackendContext);
  if (!context) {
    throw new Error('useBackend requires a BackendProvider');
  }
  return context;
};

/** Runs a backend query, reloading on data changes. */
const useBackendQuery = <A>(
  run: (client: BackendClient) => Effect.Effect<A, unknown>,
  initial: A,
): A => {
  const { client, onChanged } = useBackend();
  const [value, setValue] = useState<A>(initial);

  const reload = useCallback(() => {
    Effect.runPromise(run(client) as Effect.Effect<A, never>).then(setValue, () => {
      // Query failures leave the previous value in place; surfacing
      // connection problems is the caller's concern.
    });
  }, [client, run]);

  useEffect(() => {
    reload();
    return onChanged?.(reload) ?? undefined;
  }, [reload, onChanged]);

  return value;
};

const NO_EVENTS: ReadonlyArray<EventRecord> = [];
const NO_CALENDARS: ReadonlyArray<CalendarInfo> = [];
const NO_ACCOUNTS: ReadonlyArray<Account> = [];

export const useEventsInRange = (
  rangeStartUtc: number,
  rangeEndUtc: number,
): ReadonlyArray<EventRecord> =>
  useBackendQuery(
    useCallback(
      (client) => client.getEventsInRange({ rangeEndUtc, rangeStartUtc }),
      [rangeEndUtc, rangeStartUtc],
    ),
    NO_EVENTS,
  );

export const useCalendars = (): ReadonlyArray<CalendarInfo> =>
  useBackendQuery(
    useCallback((client) => client.listCalendars({}), []),
    NO_CALENDARS,
  );

export const useAccounts = (): ReadonlyArray<Account> =>
  useBackendQuery(
    useCallback((client) => client.listAccounts(undefined), []),
    NO_ACCOUNTS,
  );

/** The current time, updated every `intervalMs` (drives now-indicators). */
export const useNow = (intervalMs = 60_000): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
};
