import type {
  Account,
  AccountSyncStatus,
  MirrorView,
  BackendPayload,
  BirthdayLeadDays,
  BirthdayOccurrence,
  BirthdayRecord,
  BirthdayReminderOverrides,
  BirthdayReminderSettings,
  BackendSuccess,
  CalendarInfo,
  Contact,
  EventNotificationSettings,
  EventRecord,
  GeoLocation,
  PendingOpSummary,
  PlaceSuggestion,
  TaskListInfo,
  TaskRecord,
  TimeZoneSettings,
  ViewPreferences,
} from '@calendar/core';
import {
  birthdayMergeKey,
  findBirthdayOverride,
  isCalendarWritable,
  msUntilNextMidnight,
  secondaryZones,
  Temporal,
} from '@calendar/core';
import { RegistryContext, useAtomValue } from '@effect/atom-react';
import { Cause, Effect, Exit, Option } from 'effect';
import { AsyncResult, type Atom, AtomRegistry } from 'effect/reactivity';
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  type BackendAtoms,
  type MapSnapshotParams,
  mapSnapshotKey,
  type MutationName,
  rangeKey,
} from './atoms.ts';

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

/** Every calendar mirror with its state on this device. */
export const useMirrors = (): ReadonlyArray<MirrorView> =>
  unwrapList(useAtomValue(useBackendAtoms().mirrors));

/** Events history import progress per account. */
export const useSyncStatus = (): ReadonlyArray<AccountSyncStatus> =>
  unwrapList(useAtomValue(useBackendAtoms().syncStatus));

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
 * Typeahead rows for a query, holding the previous list while the next
 * one loads so a dropdown never flickers empty between keystrokes. An
 * empty query yields [] without asking the backend. `stale` = the rows
 * belong to an earlier query: show them, never select them.
 */
const useStaleSearch = <A>(
  atomFor: (key: string) => Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<A>, unknown>>,
  query: string,
  limit: number,
): { readonly rows: ReadonlyArray<A>; readonly stale: boolean } => {
  const trimmed = query.trim();
  const result = useAtomValue(atomFor(`${String(limit)}:${trimmed}`));
  const value = AsyncResult.value(result);
  const [previous, setPrevious] = useState<ReadonlyArray<A>>([]);
  if (Option.isSome(value) && value.value !== previous) {
    // Render-phase state adjustment (the React "derive from props" pattern).
    setPrevious(value.value);
  }
  if (trimmed === '') {
    return { rows: [], stale: false };
  }
  return Option.isSome(value)
    ? { rows: value.value, stale: false }
    : { rows: previous, stale: true };
};

/** Invitee suggestions for a query (device + Google contacts). */
export const useContactsSearch = (
  query: string,
  limit = 8,
): { readonly contacts: ReadonlyArray<Contact>; readonly stale: boolean } => {
  const { rows, stale } = useStaleSearch(useBackendAtoms().contactsSearch, query, limit);
  return { contacts: rows, stale };
};

/** Location typeahead rows for `query` (MapKit through the backend). */
export const usePlacesSearch = (
  query: string,
  limit = 6,
): { readonly places: ReadonlyArray<PlaceSuggestion>; readonly stale: boolean } => {
  const { rows, stale } = useStaleSearch(useBackendAtoms().placesSearch, query, limit);
  return { places: rows, stale };
};

/**
 * Coordinates for location text ('' asks nothing). A failed lookup reads
 * as "no coordinates" — a map is a nicety, never an error in the editor.
 */
export const useLocationGeo = (
  location: string,
): { readonly geo: GeoLocation | null; readonly loading: boolean } => {
  const result = useAtomValue(useBackendAtoms().locationGeo(location));
  return {
    geo: AsyncResult.isSuccess(result) ? result.value : null,
    loading: AsyncResult.isInitial(result) || (result.waiting && !AsyncResult.isFailure(result)),
  };
};

/** A static map image (desktop), base64 PNG; null while loading, failed, or not asked. */
export const useMapSnapshot = (
  params: MapSnapshotParams | null,
): { readonly loading: boolean; readonly pngBase64: string | null } => {
  const result = useAtomValue(useBackendAtoms().mapSnapshot(params ? mapSnapshotKey(params) : ''));
  return {
    loading: AsyncResult.isInitial(result),
    pngBase64: AsyncResult.isSuccess(result) ? result.value : null,
  };
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
 * Open tasks due before `before` (today's 'YYYY-MM-DD'), for the overdue
 * chips on today; keep-previous like useTasksInRangeStable.
 */
export const useOverdueTasksStable = (before: string): ReadonlyArray<TaskRecord> => {
  const atoms = useBackendAtoms();
  const result = useAtomValue(atoms.overdueTasks(before));
  const value = AsyncResult.value(result);
  const [previous, setPrevious] = useState<ReadonlyArray<TaskRecord>>([]);
  if (Option.isSome(value) && value.value !== previous) {
    // Render-phase state adjustment (the React "derive from props" pattern).
    setPrevious(value.value);
  }
  return Option.isSome(value) ? value.value : previous;
};

/**
 * Today's ISO date in `timeZone`, re-read at the next local midnight (one
 * timer, not a minute tick — the grid must not re-render every minute).
 */
export const useToday = (timeZone: string): string => {
  const [today, setToday] = useState(() => Temporal.Now.plainDateISO(timeZone).toString());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      // Also runs at once: a zone change (travel) may already be a new day.
      setToday(Temporal.Now.plainDateISO(timeZone).toString());
      timer = setTimeout(arm, msUntilNextMidnight(timeZone, Date.now()));
    };
    arm();
    return () => clearTimeout(timer);
  }, [timeZone]);
  return today;
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

/** People with their own birthday lead days; null until the first read resolves. */
export const useBirthdayReminderOverrides = (): BirthdayReminderOverrides | null => {
  const result = useAtomValue(useBackendAtoms().birthdayReminderOverrides);
  return Option.getOrNull(AsyncResult.value(result));
};

export interface BirthdayOverrideEditor {
  /** Whether birthday reminders are on at all; an override fires only then. */
  readonly enabled: boolean;
  /** The lead days that apply to this person: their own, else the general ones. */
  readonly leadDays: ReadonlyArray<BirthdayLeadDays>;
  /** false until both settings have been read. */
  readonly loaded: boolean;
  /** Whether this person has their own lead days. */
  readonly overridden: boolean;
  /** Back to the general lead days. */
  readonly reset: () => Promise<void>;
  /** Turns one lead day on or off for this person, starting from what applies now. */
  readonly toggle: (lead: BirthdayLeadDays) => Promise<void>;
}

/**
 * The detail view's per-person reminder editor. A save shows its value at
 * once and keeps showing it until the refetch it set off has landed, so
 * two quick toggles both land; after that the stored list is the truth
 * again, so a change made elsewhere while the view stays open (Reset in
 * Settings, an import, the settings file) shows up instead of being
 * shadowed by the last value sent.
 *
 * Both settings are re-read as the view opens, and it reports `loaded`
 * only once they are back. On desktop, the first open after the general
 * lead days changed in the Settings window showed the old ones (the
 * main window's copy from an earlier open was still served; a reopen
 * was fresh), and the first toggle would have saved an override built
 * from them.
 */
export const useBirthdayOverrideEditor = (
  record: Pick<BirthdayRecord, 'day' | 'displayName' | 'month'>,
): BirthdayOverrideEditor => {
  const atoms = useBackendAtoms();
  const registry = useContext(RegistryContext);
  const settings = Option.getOrNull(
    AsyncResult.value(useAtomValue(atoms.birthdayReminderSettings)),
  );
  const overridesResult = useAtomValue(atoms.birthdayReminderOverrides);
  const overrides = Option.getOrNull(AsyncResult.value(overridesResult));
  // Set once the re-read is back, never cleared: a save's own refetch must
  // not unmount the controls.
  const [refreshed, setRefreshed] = useState(false);
  useEffect(() => {
    let active = true;
    const reread = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) => {
      registry.refresh(atom);
      return Effect.exit(AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }));
    };
    void Effect.runPromise(
      Effect.all([reread(atoms.birthdayReminderSettings), reread(atoms.birthdayReminderOverrides)]),
    ).then(() => {
      if (active) {
        setRefreshed(true);
      }
    });
    return () => {
      active = false;
    };
  }, [atoms, registry]);
  const loaded = refreshed && settings !== null && overrides !== null;
  const { setBirthdayReminderOverride } = useBackendMutations();
  const key = birthdayMergeKey(record);
  // The latest save, shown until stored data has caught up with it.
  // `leadDays: null` sent "use the general ones".
  const [sent, setSent] = useState<
    | {
        readonly key: string;
        readonly leadDays: ReadonlyArray<BirthdayLeadDays> | null;
        /** The backend acknowledged it; its refetch was already under way. */
        readonly saved: boolean;
        readonly seq: number;
      }
    | undefined
  >(undefined);
  const lastSeq = useRef(0);
  // A save's invalidation runs before the save resolves, so once it is
  // acknowledged a list that is no longer waiting already holds it.
  const pending =
    sent !== undefined && sent.key === key && !(sent.saved && !overridesResult.waiting)
      ? sent
      : undefined;
  if (sent !== undefined && pending === undefined) {
    // Render-phase state adjustment (the React "derive from props" pattern).
    setSent(undefined);
  }
  const stored = overrides ? findBirthdayOverride(overrides, record)?.leadDays : undefined;
  const own = pending ? pending.leadDays : stored;
  const general = settings?.leadDays ?? [];
  const leadDays = own ?? general;
  const save = (next: ReadonlyArray<BirthdayLeadDays> | null): Promise<void> => {
    lastSeq.current += 1;
    const seq = lastSeq.current;
    setSent({ key, leadDays: next, saved: false, seq });
    return setBirthdayReminderOverride({
      day: record.day,
      displayName: record.displayName,
      leadDays: next,
      month: record.month,
    }).then(
      () => setSent((current) => (current?.seq === seq ? { ...current, saved: true } : current)),
      (error: unknown) => {
        setSent((current) => (current?.seq === seq ? undefined : current));
        throw error;
      },
    );
  };
  return {
    enabled: settings?.enabled ?? false,
    leadDays,
    loaded,
    overridden: own !== undefined && own !== null,
    reset: () => save(null),
    toggle: (lead) =>
      save(
        leadDays.includes(lead)
          ? leadDays.filter((value) => value !== lead)
          : [...leadDays, lead].sort((a, b) => a - b),
      ),
  };
};

/** The device-local event notification preferences; null until the first read resolves. */
export const useEventNotificationSettings = (): EventNotificationSettings | null => {
  const result = useAtomValue(useBackendAtoms().eventNotificationSettings);
  return Option.getOrNull(AsyncResult.value(result));
};

/**
 * A device-local setting as its editor sees it: the stored value until
 * the first change, then the last value sent. Merging a change into the
 * read value instead loses the previous change whenever the second click
 * lands before the re-read (two quick toggles). The settings UI is the
 * only writer of these keys, so its own last value is the truth; a failed
 * save falls back to the stored one.
 */
export const useSettingsEditor = <A extends object, R>(
  stored: A | null,
  persist: (next: A) => Promise<R>,
): readonly [current: A | null, save: (change: Partial<A>) => Promise<R>] => {
  const [sent, setSent] = useState<A | null>(null);
  const current = sent ?? stored;
  const save = (change: Partial<A>): Promise<R> => {
    if (!current) {
      return Promise.reject(new Error('The setting has not loaded yet.'));
    }
    const next = { ...current, ...change };
    setSent(next);
    return persist(next).catch((error: unknown) => {
      setSent(null);
      throw error;
    });
  };
  return [current, save];
};

/** The device-local time zones as stored; null until the first read resolves. For the settings editor. */
export const useTimeZoneSettings = (): TimeZoneSettings | null => {
  const result = useAtomValue(useBackendAtoms().timeZoneSettings);
  return Option.getOrNull(AsyncResult.value(result));
};

export interface TimeZones {
  /** false only before the first read; the roots gate on it so the grid never draws in the wrong zone. */
  readonly loaded: boolean;
  /** The zone the grid, "today" and the editors use. */
  readonly primary: string;
  /** The other zones, in settings order: the gutter's second line, chips and the editor helper. */
  readonly secondary: ReadonlyArray<string>;
}

/**
 * The zones the calendar draws. Before the first read this is a single
 * device zone; after it, the last loaded value survives the refetch that
 * follows a write, so a primary never falls back mid-session.
 */
export const useTimeZones = (): TimeZones => {
  const stored = useTimeZoneSettings();
  const [last, setLast] = useState<TimeZoneSettings | null>(null);
  if (stored !== null && stored !== last) {
    // Render-phase state adjustment (the React "derive from props" pattern).
    setLast(stored);
  }
  const settings = stored ?? last;
  return useMemo(
    () =>
      settings === null
        ? { loaded: false, primary: Temporal.Now.timeZoneId(), secondary: [] }
        : { loaded: true, primary: settings.primary, secondary: secondaryZones(settings) },
    [settings],
  );
};

/** The device-local view preferences; null until the first read resolves (treat as the defaults). */
export const useViewPreferences = (): ViewPreferences | null => {
  const result = useAtomValue(useBackendAtoms().viewPreferences);
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

/** Whether a task's list refuses mutations, keyed by account and list id. */
export const useTaskReadOnlyLookup = (): ((task: TaskRecord) => boolean) => {
  const taskLists = useTaskLists();
  return useMemo(() => {
    const readOnlyLists = new Set(
      taskLists
        .filter((list) => list.readOnly === true)
        .map((list) => `${list.accountId}:${list.id}`),
    );
    return (task: TaskRecord) => readOnlyLists.has(`${task.accountId}:${task.listId}`);
  }, [taskLists]);
};

/**
 * Whether an event lives in a calendar we cannot write (a shared calendar
 * with reader access, a subscription, birthdays): its blocks open as a
 * viewer and never start a drag. EventMutations refuses the write too.
 */
export const useEventReadOnlyLookup = (): ((event: EventRecord) => boolean) => {
  const calendars = useCalendars();
  return useMemo(() => {
    const readOnly = new Set(
      calendars
        .filter((calendar) => !isCalendarWritable(calendar))
        .map((calendar) => `${calendar.accountId}:${calendar.id}`),
    );
    return (event: EventRecord) => readOnly.has(`${event.accountId}:${event.calendarId}`);
  }, [calendars]);
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
      clearLocationCache: set('clearLocationCache'),
      completeTask: set('completeTask'),
      connectAppleCalendar: set('connectAppleCalendar'),
      connectContacts: set('connectContacts'),
      connectReminders: set('connectReminders'),
      convertEventToTask: set('convertEventToTask'),
      convertTaskToEvent: set('convertTaskToEvent'),
      createEvent: set('createEvent'),
      createMirrorCalendar: set('createMirrorCalendar'),
      createTask: set('createTask'),
      deleteEvent: set('deleteEvent'),
      deleteMirror: set('deleteMirror'),
      deleteRecurring: set('deleteRecurring'),
      deleteTask: set('deleteTask'),
      discardPendingOp: set('discardPendingOp'),
      exportSettings: set('exportSettings'),
      importSettings: set('importSettings'),
      moveEvent: set('moveEvent'),
      moveTask: set('moveTask'),
      previewEventToTask: set('previewEventToTask'),
      previewMirror: set('previewMirror'),
      previewMove: set('previewMove'),
      previewSettingsImport: set('previewSettingsImport'),
      removeAccount: set('removeAccount'),
      resolveConflict: set('resolveConflict'),
      resolveLocation: set('resolveLocation'),
      respondToEvent: set('respondToEvent'),
      runMirrorsNow: set('runMirrorsNow'),
      saveMirror: set('saveMirror'),
      setBirthdayReminderOverride: set('setBirthdayReminderOverride'),
      setBirthdayReminderSettings: set('setBirthdayReminderSettings'),
      setCalendarColor: set('setCalendarColor'),
      setCalendarVisible: set('setCalendarVisible'),
      setEventNotificationSettings: set('setEventNotificationSettings'),
      setMirrorEnabled: set('setMirrorEnabled'),
      setTaskListVisible: set('setTaskListVisible'),
      setTimeZoneSettings: set('setTimeZoneSettings'),
      setViewPreferences: set('setViewPreferences'),
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
