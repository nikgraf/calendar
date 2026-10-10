import { findSlotsFor, parseFindTime, type LanguageModel } from '@calendar/ai';
import {
  type BackendClient,
  defaultFinderConstraints,
  type EventRecord,
  type FinderBounds,
  finderBoundsOf,
  finderCustomNote,
  finderDaysOf,
  type FinderDays,
  type FinderWindow,
  finderWindowOf,
  type FindSlotsConstraints,
  type FreeSlot,
  isDrawnOccurrence,
  isSameEvent,
  type RecurringScope,
  withFinderBounds,
  withFinderDays,
  withFinderWindow,
} from '@calendar/core';
import { useEffect, useRef, useState } from 'react';
import { useToday } from './hooks.ts';

/** What the finder's exclusion knows of an existing series' master (`useEventMaster`). */
export interface MasterSeries {
  readonly recurrence: ReadonlyArray<string> | undefined;
  readonly startUtc: number | undefined;
}

const hasFixedDates = (recurrence: ReadonlyArray<string> | undefined): boolean =>
  (recurrence ?? []).some((line) => line.toUpperCase().startsWith('RDATE'));

/**
 * Rows the finder must not count as busy: what the save will move or
 * drop, read off `updateRecurring`. "This event": the row itself (by
 * identity, not id — an occurrence's drawn id becomes Google's once it
 * is edited on its own, which a sync can land mid-edit). "All events",
 * and "This and following" from the series' first occurrence: the master
 * shifts, so every occurrence drawn from its rule moves, while a stored
 * exception keeps its own times — it stays busy, the opened row
 * included — and so does an occurrence drawn from a fixed RDATE, which
 * the drawn rows do not tell apart from the rule's: a series with fixed
 * dates keeps every row busy. "This and following" later in the series:
 * the split drops every row from the split point, drawn or stored, and
 * the earlier ones stay. Until the master is here, a stored exception is
 * kept busy either way.
 */
export const rescheduledEventExclusion = (
  existing: EventRecord | undefined,
  scope: RecurringScope,
  /** The series' master, undefined until loaded. */
  master?: MasterSeries | undefined,
): ((event: EventRecord) => boolean) | undefined => {
  if (!existing) {
    return undefined;
  }
  const masterId = existing.recurringEventId;
  const from = existing.originalStartUtc ?? existing.startUtc;
  const masterStartUtc = master?.startUtc;
  const shiftsSeries =
    scope === 'series' ||
    (scope === 'following' && masterStartUtc !== undefined && from <= masterStartUtc);
  const fixedDates = master === undefined || hasFixedDates(master.recurrence);
  return (event) => {
    if (event.accountId !== existing.accountId || event.calendarId !== existing.calendarId) {
      return false;
    }
    if (masterId === undefined || scope === 'instance') {
      return isSameEvent(event, existing);
    }
    if (event.recurringEventId !== masterId) {
      return false;
    }
    if (shiftsSeries) {
      return !fixedDates && isDrawnOccurrence(event);
    }
    const start = event.originalStartUtc ?? event.startUtc;
    return start >= from && (isDrawnOccurrence(event) || masterStartUtc !== undefined);
  };
};

/**
 * The event form's "Find a time", shared by both shells: a few presets
 * (window, daily bounds, days, duration) over the pure solver, so a free
 * slot is a tap away with no model involved; a phrase, where the model
 * is available, fills the same constraints. The duration starts as the
 * form's own (the times it holds); a picked slot goes back into the form
 * through `applySlot` on the event model.
 */
export const useFindTimeModel = ({
  backend,
  contextKey,
  durationMinutes,
  excludeEvent,
  model,
  onTitle,
  timeZone,
}: {
  readonly backend: BackendClient;
  /**
   * Names what `excludeEvent` depends on (the series edit's scope): when
   * it changes, slots found under the old exclusion are dropped.
   */
  readonly contextKey?: string | undefined;
  /** The form's current duration (its start to its end), the finder's starting one. */
  readonly durationMinutes: number;
  /** Rows that are not busy time: the event being rescheduled (`rescheduledEventExclusion`). */
  readonly excludeEvent?: ((event: EventRecord) => boolean) | undefined;
  readonly model: LanguageModel;
  /** A phrase named what the time is for: the form may take it as its title. */
  readonly onTitle?: ((title: string) => void) | undefined;
  readonly timeZone: string;
}) => {
  const today = useToday(timeZone);
  // A search or a read takes a while; a constraint changed, or the finder
  // reopened, meanwhile makes its answer stale. Each change bumps the
  // request, and an answer counts only while it is the latest.
  const request = useRef(0);
  // The latest render's callback: the title it checks is the one typed by then.
  const onTitleRef = useRef(onTitle);
  useEffect(() => {
    onTitleRef.current = onTitle;
  }, [onTitle]);
  const [open, setOpen] = useState(false);
  const [constraints, setConstraints] = useState<FindSlotsConstraints>(() =>
    defaultFinderConstraints(durationMinutes, today),
  );
  const [phrase, setPhrase] = useState('');
  const [slots, setSlots] = useState<ReadonlyArray<FreeSlot> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Drops the slots on show and any answer still coming; nothing is busy after it. */
  const invalidate = () => {
    request.current += 1;
    setSlots(null);
    setError(null);
    setBusy(false);
  };
  /** A changed constraint drops the slots found for the old ones. */
  const update = (next: FindSlotsConstraints) => {
    invalidate();
    setConstraints(next);
  };
  // Gone (the kind flipped to a task): an answer still coming must not
  // touch the form, which stays mounted.
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  // The exclusion changed under the slots (the scope control): they were
  // found with other rows free.
  const seenContext = useRef(contextKey);
  useEffect(() => {
    if (seenContext.current !== contextKey) {
      seenContext.current = contextKey;
      invalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a changed key invalidates
  }, [contextKey]);

  const search = async () => {
    const mine = ++request.current;
    setBusy(true);
    setError(null);
    try {
      const found = await findSlotsFor(backend, constraints, timeZone, { exclude: excludeEvent });
      if (mine !== request.current) {
        return;
      }
      if ('reason' in found) {
        setSlots(null);
        setError(found.reason);
      } else {
        setSlots(found);
        setError(found.length === 0 ? 'No free slots match — widen the window?' : null);
      }
    } finally {
      if (mine === request.current) {
        setBusy(false);
      }
    }
  };

  /** Reads the phrase into the presets (and the title, when it names one); nothing is searched yet. */
  const readPhrase = async () => {
    if (!phrase.trim()) {
      return;
    }
    const mine = ++request.current;
    setBusy(true);
    setError(null);
    try {
      const parsed = await parseFindTime(model, { phrase, referenceDate: today, timeZone });
      if (mine !== request.current) {
        return;
      }
      if (parsed.kind === 'rejected') {
        setError(parsed.reason);
        return;
      }
      update(parsed.constraints);
      if (parsed.title) {
        onTitleRef.current?.(parsed.title);
      }
    } catch {
      if (mine === request.current) {
        setError('On-device model unavailable.');
      }
    } finally {
      if (mine === request.current) {
        setBusy(false);
      }
    }
  };

  return {
    bounds: finderBoundsOf(constraints),
    busy,
    close: () => {
      invalidate();
      setOpen(false);
    },
    constraints,
    /** What a phrase set that no preset names, in words; null when the controls say it all. */
    customNote: finderCustomNote(constraints, today),
    days: finderDaysOf(constraints),
    error,
    open,
    /** Opens on the form's duration now, this week, any day and time. */
    openFinder: () => {
      update(defaultFinderConstraints(durationMinutes, today));
      setOpen(true);
    },
    phrase,
    readPhrase,
    search,
    setBounds: (bounds: FinderBounds) => update(withFinderBounds(constraints, bounds)),
    setDays: (days: FinderDays) => update(withFinderDays(constraints, days)),
    setDuration: (minutes: number) => update({ ...constraints, durationMinutes: minutes }),
    setPhrase,
    setWindow: (window: FinderWindow) => update(withFinderWindow(constraints, window, today)),
    slots,
    window: finderWindowOf(constraints, today),
  };
};
