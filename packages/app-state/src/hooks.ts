import type { Account, CalendarInfo, EventRecord } from '@calendar/core';
import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react';
import { Option } from 'effect';
import { AsyncResult } from 'effect/unstable/reactivity';
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { rangeKey, type BackendAtoms } from './atoms.ts';

const AtomsContext = createContext<BackendAtoms | null>(null);

export const BackendProvider = ({
  atoms,
  children,
}: {
  atoms: BackendAtoms;
  children: ReactNode;
}) => createElement(AtomsContext.Provider, { value: atoms }, children);

export const useBackendAtoms = (): BackendAtoms => {
  const atoms = useContext(AtomsContext);
  if (!atoms) {
    throw new Error('useBackendAtoms requires a BackendProvider');
  }
  return atoms;
};

/**
 * Binds backend-side invalidation keys into the atom runtime for the lifetime
 * of the component (mount once near the app root).
 */
export const useBackendInvalidations = (
  subscribe: (listener: (keys: ReadonlyArray<unknown>) => void) => () => void,
): void => {
  const atoms = useBackendAtoms();
  const registry = useContext(RegistryContext);
  useEffect(() => atoms.bindInvalidations(registry, subscribe), [atoms, registry, subscribe]);
};

/** Unwraps AsyncResult list atoms: previous success during refetch, [] initially. */
const unwrapList = <A>(
  result: AsyncResult.AsyncResult<ReadonlyArray<A>, unknown>,
): ReadonlyArray<A> => Option.getOrElse(AsyncResult.value(result), (): ReadonlyArray<A> => []);

export const useAccounts = (): ReadonlyArray<Account> =>
  unwrapList(useAtomValue(useBackendAtoms().accounts));

export const useCalendars = (): ReadonlyArray<CalendarInfo> =>
  unwrapList(useAtomValue(useBackendAtoms().calendars));

export const useEventsInRange = (
  rangeStartUtc: number,
  rangeEndUtc: number,
): ReadonlyArray<EventRecord> => {
  const atoms = useBackendAtoms();
  return unwrapList(useAtomValue(atoms.eventsInRange(rangeKey(rangeStartUtc, rangeEndUtc))));
};

/** Promise-returning mutation callbacks; each invalidates its reactivity keys. */
export const useBackendMutations = () => {
  const { mutations } = useBackendAtoms();
  const addAccount = useAtomSet(mutations.addAccount, { mode: 'promise' });
  const createEvent = useAtomSet(mutations.createEvent, { mode: 'promise' });
  const deleteEvent = useAtomSet(mutations.deleteEvent, { mode: 'promise' });
  const deleteRecurring = useAtomSet(mutations.deleteRecurring, {
    mode: 'promise',
  });
  const removeAccount = useAtomSet(mutations.removeAccount, {
    mode: 'promise',
  });
  const respondToEvent = useAtomSet(mutations.respondToEvent, {
    mode: 'promise',
  });
  const setCalendarVisible = useAtomSet(mutations.setCalendarVisible, {
    mode: 'promise',
  });
  const syncNow = useAtomSet(mutations.syncNow, { mode: 'promise' });
  const updateEvent = useAtomSet(mutations.updateEvent, { mode: 'promise' });
  const updateRecurring = useAtomSet(mutations.updateRecurring, {
    mode: 'promise',
  });

  return useMemo(
    () => ({
      addAccount,
      createEvent,
      deleteEvent,
      deleteRecurring,
      removeAccount,
      respondToEvent,
      setCalendarVisible,
      syncNow,
      updateEvent,
      updateRecurring,
    }),
    [
      addAccount,
      createEvent,
      deleteEvent,
      deleteRecurring,
      removeAccount,
      respondToEvent,
      setCalendarVisible,
      syncNow,
      updateEvent,
      updateRecurring,
    ],
  );
};

/** The current time, updated every `intervalMs` (drives now-indicators). */
export const useNow = (intervalMs = 60_000): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
};
