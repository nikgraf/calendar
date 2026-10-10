import { findSlotsFor, parseFindTime, type LanguageModel } from '@calendar/ai';
import {
  type BackendClient,
  defaultFinderConstraints,
  type FinderBounds,
  finderBoundsOf,
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
import { useState } from 'react';
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
  model,
  onTitle,
  timeZone,
}: {
  readonly backend: BackendClient;
  /** The form's current duration (its start to its end), the finder's starting one. */
  readonly durationMinutes: number;
  readonly model: LanguageModel;
  /** A phrase named what the time is for: the form may take it as its title. */
  readonly onTitle?: ((title: string) => void) | undefined;
  readonly timeZone: string;
}) => {
  const today = useToday(timeZone);
  const [open, setOpen] = useState(false);
  const [constraints, setConstraints] = useState<FindSlotsConstraints>(() =>
    defaultFinderConstraints(durationMinutes, today),
  );
  const [phrase, setPhrase] = useState('');
  const [slots, setSlots] = useState<ReadonlyArray<FreeSlot> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** A changed constraint drops the slots found for the old ones. */
  const update = (next: FindSlotsConstraints) => {
    setConstraints(next);
    setSlots(null);
    setError(null);
  };

  const search = async () => {
    setBusy(true);
    setError(null);
    try {
      const found = await findSlotsFor(backend, constraints, timeZone);
      if ('reason' in found) {
        setSlots(null);
        setError(found.reason);
      } else {
        setSlots(found);
        setError(found.length === 0 ? 'No free slots match — widen the window?' : null);
      }
    } finally {
      setBusy(false);
    }
  };

  /** Reads the phrase into the presets (and the title, when it names one); nothing is searched yet. */
  const readPhrase = async () => {
    if (!phrase.trim()) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const parsed = await parseFindTime(model, { phrase, referenceDate: today, timeZone });
      if (parsed.kind === 'rejected') {
        setError(parsed.reason);
        return;
      }
      update(parsed.constraints);
      if (parsed.title) {
        onTitle?.(parsed.title);
      }
    } catch {
      setError('On-device model unavailable.');
    } finally {
      setBusy(false);
    }
  };

  return {
    bounds: finderBoundsOf(constraints),
    busy,
    close: () => setOpen(false),
    constraints,
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
