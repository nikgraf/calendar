import type {
  Account,
  CalendarInfo,
  Contact,
  EventRecord,
  PendingOpSummary,
  TaskListInfo,
  TaskRecord,
} from '@calendar/core';
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

/** Queue of local changes not yet acknowledged by Google. */
export const usePendingOps = (): ReadonlyArray<PendingOpSummary> =>
  unwrapList(useAtomValue(useBackendAtoms().pendingOps));

/**
 * Returns a range's events, keeping the previous range's events on screen
 * while a brand-new range atom is still loading — continuous navigation
 * (panning across days) never flashes an empty grid between ranges.
 */
export const useEventsInRangeStable = (
  rangeStartUtc: number,
  rangeEndUtc: number,
): ReadonlyArray<EventRecord> => {
  const atoms = useBackendAtoms();
  const result = useAtomValue(atoms.eventsInRange(rangeKey(rangeStartUtc, rangeEndUtc)));
  const value = AsyncResult.value(result);
  const [previous, setPrevious] = useState<ReadonlyArray<EventRecord>>([]);
  if (Option.isSome(value) && value.value !== previous) {
    // Render-phase state adjustment (the React "derive from props" pattern).
    setPrevious(value.value);
  }
  return Option.isSome(value) ? value.value : previous;
};

/**
 * Invitee suggestions for a query, holding the previous list while the
 * next one loads so the dropdown never flickers empty between keystrokes.
 * An empty query yields [] without asking the backend.
 */
export const useContactsSearch = (
  query: string,
  limit = 8,
): { readonly contacts: ReadonlyArray<Contact>; readonly stale: boolean } => {
  const atoms = useBackendAtoms();
  const trimmed = query.trim();
  const result = useAtomValue(atoms.contactsSearch(`${String(limit)}:${trimmed}`));
  const value = AsyncResult.value(result);
  const [previous, setPrevious] = useState<ReadonlyArray<Contact>>([]);
  if (Option.isSome(value) && value.value !== previous) {
    // Render-phase state adjustment (the React "derive from props" pattern).
    setPrevious(value.value);
  }
  if (trimmed === '') {
    return { contacts: [], stale: false };
  }
  // `stale` = the rows belong to an earlier query; show them, never select them.
  return Option.isSome(value)
    ? { contacts: value.value, stale: false }
    : { contacts: previous, stale: true };
};

/** Task lists across accounts (for visibility toggles + connect rows). */
export const useTaskLists = (): ReadonlyArray<TaskListInfo> => {
  const atoms = useBackendAtoms();
  return unwrapList(useAtomValue(atoms.taskLists));
};

/**
 * Tasks due inside [startDate, endDate] (inclusive 'YYYY-MM-DD' bounds),
 * with the same keep-previous behavior as useEventsInRangeStable.
 */
export const useTasksInRangeStable = (
  startDate: string,
  endDate: string,
): ReadonlyArray<TaskRecord> => {
  const atoms = useBackendAtoms();
  const result = useAtomValue(atoms.tasksInRange(`${startDate}:${endDate}`));
  const value = AsyncResult.value(result);
  const [previous, setPrevious] = useState<ReadonlyArray<TaskRecord>>([]);
  if (Option.isSome(value) && value.value !== previous) {
    // Render-phase state adjustment (the React "derive from props" pattern).
    setPrevious(value.value);
  }
  return Option.isSome(value) ? value.value : previous;
};

/** Promise-returning mutation callbacks; each invalidates its reactivity keys. */
export const useBackendMutations = () => {
  const { mutations } = useBackendAtoms();
  const addAccount = useAtomSet(mutations.addAccount, { mode: 'promise' });
  const completeTask = useAtomSet(mutations.completeTask, { mode: 'promise' });
  const connectContacts = useAtomSet(mutations.connectContacts, { mode: 'promise' });
  const connectReminders = useAtomSet(mutations.connectReminders, { mode: 'promise' });
  const createTask = useAtomSet(mutations.createTask, { mode: 'promise' });
  const createEvent = useAtomSet(mutations.createEvent, { mode: 'promise' });
  const deleteEvent = useAtomSet(mutations.deleteEvent, { mode: 'promise' });
  const deleteTask = useAtomSet(mutations.deleteTask, { mode: 'promise' });
  const deleteRecurring = useAtomSet(mutations.deleteRecurring, {
    mode: 'promise',
  });
  const discardPendingOp = useAtomSet(mutations.discardPendingOp, {
    mode: 'promise',
  });
  const removeAccount = useAtomSet(mutations.removeAccount, {
    mode: 'promise',
  });
  const respondToEvent = useAtomSet(mutations.respondToEvent, {
    mode: 'promise',
  });
  const setCalendarColor = useAtomSet(mutations.setCalendarColor, {
    mode: 'promise',
  });
  const setCalendarVisible = useAtomSet(mutations.setCalendarVisible, {
    mode: 'promise',
  });
  const setTaskListVisible = useAtomSet(mutations.setTaskListVisible, {
    mode: 'promise',
  });
  const syncNow = useAtomSet(mutations.syncNow, { mode: 'promise' });
  const updateEvent = useAtomSet(mutations.updateEvent, { mode: 'promise' });
  const updateRecurring = useAtomSet(mutations.updateRecurring, {
    mode: 'promise',
  });
  const updateTask = useAtomSet(mutations.updateTask, { mode: 'promise' });

  return useMemo(
    () => ({
      addAccount,
      completeTask,
      connectContacts,
      connectReminders,
      createEvent,
      createTask,
      deleteEvent,
      deleteRecurring,
      deleteTask,
      discardPendingOp,
      removeAccount,
      respondToEvent,
      setCalendarColor,
      setCalendarVisible,
      setTaskListVisible,
      syncNow,
      updateEvent,
      updateRecurring,
      updateTask,
    }),
    [
      addAccount,
      completeTask,
      connectContacts,
      connectReminders,
      createEvent,
      createTask,
      deleteEvent,
      deleteRecurring,
      deleteTask,
      discardPendingOp,
      removeAccount,
      respondToEvent,
      setCalendarColor,
      setCalendarVisible,
      setTaskListVisible,
      syncNow,
      updateEvent,
      updateRecurring,
      updateTask,
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
