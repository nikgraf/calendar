import type {
  Account,
  BackendPayload,
  BirthdayOccurrence,
  BirthdayReminderSettings,
  BackendSuccess,
  CalendarInfo,
  Contact,
  EventRecord,
  PendingOpSummary,
  TaskListInfo,
  TaskRecord,
} from '@calendar/core';
import { RegistryContext, useAtomValue } from '@effect/atom-react';
import { Cause, Effect, Exit, Option } from 'effect';
import { AsyncResult, AtomRegistry } from 'effect/unstable/reactivity';
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { type MutationName, rangeKey, type BackendAtoms } from './atoms.ts';

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

/**
 * Contact birthdays falling inside [startDate, endDate] (inclusive
 * 'YYYY-MM-DD' bounds), with the same keep-previous behavior as
 * useTasksInRangeStable.
 */
export const useBirthdaysInRangeStable = (
  startDate: string,
  endDate: string,
): ReadonlyArray<BirthdayOccurrence> => {
  const atoms = useBackendAtoms();
  const result = useAtomValue(atoms.birthdaysInRange(`${startDate}:${endDate}`));
  const value = AsyncResult.value(result);
  const [previous, setPrevious] = useState<ReadonlyArray<BirthdayOccurrence>>([]);
  if (Option.isSome(value) && value.value !== previous) {
    // Render-phase state adjustment (the React "derive from props" pattern).
    setPrevious(value.value);
  }
  return Option.isSome(value) ? value.value : previous;
};

/** The device-local reminder preferences; null until the first read resolves. */
export const useBirthdayReminderSettings = (): BirthdayReminderSettings | null => {
  const result = useAtomValue(useBackendAtoms().birthdayReminderSettings);
  return Option.getOrNull(AsyncResult.value(result));
};

/** Reminders lists carry a color; Google lists render neutral. Both lanes need this. */
export const useListColorLookup = (): ((task: TaskRecord) => string | undefined) => {
  const taskLists = useTaskLists();
  return useMemo(() => {
    const colors = new Map(
      taskLists.map((list) => [`${list.accountId}:${list.id}`, list.colorHex]),
    );
    return (task: TaskRecord) => colors.get(`${task.accountId}:${task.listId}`);
  }, [taskLists]);
};

/**
 * Promise-returning mutation callbacks; each invalidates its reactivity keys.
 *
 * Built once per registry from the atoms record instead of nineteen
 * `useAtomSet` calls: that hook mounts its atom in an effect, so every
 * consumer (editors, sidebar, settings, drag) paid nineteen mounts and a
 * nineteen-dependency memo. A fn atom needs no mount to be set — the
 * registry runs it and the reactivity keys fire on completion, which is
 * exactly what promise mode did.
 */
export const useBackendMutations = () => {
  const { mutations } = useBackendAtoms();
  const registry = useContext(RegistryContext);
  return useMemo(() => {
    const set =
      <M extends MutationName>(name: M) =>
      async (payload: BackendPayload<M>): Promise<BackendSuccess<M>> => {
        const atom = mutations[name];
        registry.set(atom, payload as never);
        const result: Effect.Effect<BackendSuccess<M>, unknown> = AtomRegistry.getResult(
          registry,
          atom,
          { suspendOnWaiting: true },
        );
        const exit = await Effect.runPromiseExit(result);
        if (Exit.isSuccess(exit)) {
          return exit.value;
        }
        throw Cause.squash(exit.cause);
      };
    return {
      addAccount: set('addAccount'),
      completeTask: set('completeTask'),
      connectContacts: set('connectContacts'),
      connectReminders: set('connectReminders'),
      createEvent: set('createEvent'),
      createTask: set('createTask'),
      deleteEvent: set('deleteEvent'),
      deleteRecurring: set('deleteRecurring'),
      deleteTask: set('deleteTask'),
      discardPendingOp: set('discardPendingOp'),
      removeAccount: set('removeAccount'),
      respondToEvent: set('respondToEvent'),
      setBirthdayReminderSettings: set('setBirthdayReminderSettings'),
      setCalendarColor: set('setCalendarColor'),
      setCalendarVisible: set('setCalendarVisible'),
      setTaskListVisible: set('setTaskListVisible'),
      syncNow: set('syncNow'),
      updateEvent: set('updateEvent'),
      updateRecurring: set('updateRecurring'),
      updateTask: set('updateTask'),
    };
  }, [mutations, registry]);
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
