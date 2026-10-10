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
  withFinderBounds,
  withFinderDays,
  withFinderWindow,
} from '@calendar/core';
import { useEffect, useRef, useState } from 'react';
import { useToday } from './hooks.ts';

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
  durationMinutes,
  excludeEvent,
  model,
  onTitle,
  timeZone,
}: {
  readonly backend: BackendClient;
  /** The form's current duration (its start to its end), the finder's starting one. */
  readonly durationMinutes: number;
  /** Rows that are not busy time: the event being rescheduled, so its own slot is free to it. */
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

  /** A changed constraint drops the slots found for the old ones, and any answer still coming. */
  const update = (next: FindSlotsConstraints) => {
    request.current += 1;
    setConstraints(next);
    setSlots(null);
    setError(null);
  };

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
      request.current += 1;
      setBusy(false);
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
