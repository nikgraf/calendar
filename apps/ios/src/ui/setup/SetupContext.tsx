import { useUpdateOnboarding } from '@calendar/app-state';
import type { SettingsImportSummary, SetupOutcome } from '@calendar/core';
import { useNavigation } from 'expo-router';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

/** What "What do you use?" offers; Google Calendar and Tasks share a sign-in. */
export interface SetupSources {
  readonly appleCalendar: boolean;
  readonly googleCalendar: boolean;
  readonly googleTasks: boolean;
  readonly reminders: boolean;
}

/** The screens after "What do you use?", one per ticked source. */
export type SetupStep = 'apple-calendar' | 'google' | 'reminders' | 'sources';

const DEFAULT_SOURCES: SetupSources = {
  appleCalendar: true,
  googleCalendar: true,
  googleTasks: true,
  reminders: false,
};

/** The steps the ticks lead through, sources first. */
export const setupSteps = (sources: SetupSources): ReadonlyArray<SetupStep> => [
  'sources',
  ...(sources.googleCalendar || sources.googleTasks ? ['google' as const] : []),
  ...(sources.appleCalendar ? ['apple-calendar' as const] : []),
  ...(sources.reminders ? ['reminders' as const] : []),
];

interface SetupValue {
  /** Leaves the setup for the calendar, recording how it ended. */
  readonly finish: (outcome: SetupOutcome) => void;
  /** What the copy door imported, for the screen after it. */
  readonly imported: SettingsImportSummary | null;
  /** The step after `step`, or the calendar when it was the last. */
  readonly next: (step: SetupStep) => void;
  readonly setImported: (summary: SettingsImportSummary) => void;
  readonly setSources: (sources: SetupSources) => void;
  readonly sources: SetupSources;
  /** "Step n of m" for the dots: `step`'s place among the steps the ticks lead through. */
  readonly stepPosition: (step: SetupStep) => { readonly index: number; readonly total: number };
  readonly steps: ReadonlyArray<SetupStep>;
}

const SetupContext = createContext<SetupValue | null>(null);

/** The route of a step, under `/setup`. */
const stepPath = (step: SetupStep): `/setup/${SetupStep}` => `/setup/${step}`;

/**
 * The first run's own state, above its pages: what was ticked, the
 * steps that follow from it, and the way out — the outcome written to
 * the device, then the modal closed from whatever page it is on (the
 * pages' own stack sits inside the root's `setup` screen, so its parent
 * is what goes back).
 */
export function SetupProvider({ children }: { children: ReactNode }) {
  const navigation = useNavigation();
  const update = useUpdateOnboarding();
  const [sources, setSources] = useState<SetupSources>(DEFAULT_SOURCES);
  const [imported, setImported] = useState<SettingsImportSummary | null>(null);
  const steps = useMemo(() => setupSteps(sources), [sources]);

  const finish = useCallback(
    (outcome: SetupOutcome) => {
      void update({ setup: outcome });
      navigation.getParent()?.goBack();
    },
    [navigation, update],
  );

  const next = useCallback(
    (step: SetupStep) => {
      const following = steps[steps.indexOf(step) + 1];
      if (following === undefined) {
        finish('done');
      } else {
        navigation.navigate(stepPath(following) as never);
      }
    },
    [finish, navigation, steps],
  );

  const value = useMemo<SetupValue>(
    () => ({
      finish,
      imported,
      next,
      setImported,
      setSources,
      sources,
      stepPosition: (step) => ({ index: steps.indexOf(step), total: steps.length }),
      steps,
    }),
    [finish, imported, next, sources, steps],
  );
  return <SetupContext.Provider value={value}>{children}</SetupContext.Provider>;
}

/** The first run's state; only inside `SetupProvider`. */
export const useSetup = (): SetupValue => {
  const value = useContext(SetupContext);
  if (!value) {
    throw new Error('useSetup outside SetupProvider');
  }
  return value;
};
