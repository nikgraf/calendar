import { Temporal } from '../time/temporal.ts';
import type { FindSlotsConstraints } from './findSlots.ts';

/**
 * The event form's "Find a time": the solver's constraints as a few
 * presets a thumb can pick, so a free slot is one tap away without the
 * model. A parsed phrase sets the same constraints directly; the presets
 * then read back which one (if any) the constraints match.
 */

export type FinderWindow = 'fortnight' | 'nextWeek' | 'today' | 'week';
export type FinderBounds = 'afternoons' | 'any' | 'evenings' | 'mornings';
export type FinderDays = 'any' | 'weekdays' | 'weekends';

export const FINDER_WINDOWS: ReadonlyArray<{
  readonly label: string;
  readonly value: FinderWindow;
}> = [
  { label: 'Today', value: 'today' },
  { label: 'This week', value: 'week' },
  { label: 'Next week', value: 'nextWeek' },
  { label: '2 weeks', value: 'fortnight' },
];

/** The daily bounds, the same hours the find-time prompt reads "mornings" as. */
export const FINDER_BOUNDS: ReadonlyArray<{
  readonly label: string;
  readonly times: { readonly earliestTime: string; readonly latestTime: string } | undefined;
  readonly value: FinderBounds;
}> = [
  { label: 'Any time', times: undefined, value: 'any' },
  { label: 'Mornings', times: { earliestTime: '08:00', latestTime: '12:00' }, value: 'mornings' },
  {
    label: 'Afternoons',
    times: { earliestTime: '12:00', latestTime: '17:00' },
    value: 'afternoons',
  },
  { label: 'Evenings', times: { earliestTime: '17:00', latestTime: '21:00' }, value: 'evenings' },
];

export const FINDER_DAYS: ReadonlyArray<{
  readonly days: ReadonlyArray<number> | undefined;
  readonly label: string;
  readonly value: FinderDays;
}> = [
  { days: undefined, label: 'Any day', value: 'any' },
  { days: [1, 2, 3, 4, 5], label: 'Weekdays', value: 'weekdays' },
  { days: [6, 7], label: 'Weekends', value: 'weekends' },
];

/** Durations on offer; the form's own duration is searched for as it is when it is none of these. */
export const FINDER_DURATIONS: ReadonlyArray<{ readonly label: string; readonly minutes: number }> =
  [
    { label: '30 min', minutes: 30 },
    { label: '45 min', minutes: 45 },
    { label: '1 h', minutes: 60 },
    { label: '90 min', minutes: 90 },
    { label: '2 h', minutes: 120 },
  ];

const minuteOf = (time: string): number => {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  return hour * 60 + minute;
};

/** Minutes from one wall-clock time to a later one on the same day; 0 when not later. */
export const minutesBetween = (startTime: string, endTime: string): number =>
  Math.max(0, minuteOf(endTime) - minuteOf(startTime));

/**
 * The date window a preset names, from today: this week runs to the
 * coming Sunday (today alone on a Sunday), next week is the Monday to
 * Sunday after that, two weeks is today and the thirteen days after.
 */
export const finderWindowDates = (
  window: FinderWindow,
  today: string,
): { readonly windowEndDate: string; readonly windowStartDate: string } => {
  const day = Temporal.PlainDate.from(today);
  const toSunday = 7 - day.dayOfWeek;
  switch (window) {
    case 'today':
      return { windowEndDate: today, windowStartDate: today };
    case 'week':
      return { windowEndDate: day.add({ days: toSunday }).toString(), windowStartDate: today };
    case 'nextWeek': {
      const monday = day.add({ days: toSunday + 1 });
      return {
        windowEndDate: monday.add({ days: 6 }).toString(),
        windowStartDate: monday.toString(),
      };
    }
    case 'fortnight':
      return { windowEndDate: day.add({ days: 13 }).toString(), windowStartDate: today };
  }
};

/** What a new finder searches for: this week, any day, any time, the form's duration. */
export const defaultFinderConstraints = (
  durationMinutes: number,
  today: string,
): FindSlotsConstraints => ({
  durationMinutes: durationMinutes > 0 ? durationMinutes : 60,
  ...finderWindowDates('week', today),
});

export const withFinderWindow = (
  constraints: FindSlotsConstraints,
  window: FinderWindow,
  today: string,
): FindSlotsConstraints => ({ ...constraints, ...finderWindowDates(window, today) });

export const withFinderBounds = (
  constraints: FindSlotsConstraints,
  bounds: FinderBounds,
): FindSlotsConstraints => {
  const { earliestTime: _earliest, latestTime: _latest, ...rest } = constraints;
  const times = FINDER_BOUNDS.find((option) => option.value === bounds)?.times;
  return times ? { ...rest, ...times } : rest;
};

export const withFinderDays = (
  constraints: FindSlotsConstraints,
  days: FinderDays,
): FindSlotsConstraints => {
  const { daysOfWeek: _days, ...rest } = constraints;
  const set = FINDER_DAYS.find((option) => option.value === days)?.days;
  return set ? { ...rest, daysOfWeek: set } : rest;
};

/** The window preset the constraints equal, if any (a phrase can name any dates). */
export const finderWindowOf = (
  constraints: FindSlotsConstraints,
  today: string,
): FinderWindow | undefined =>
  FINDER_WINDOWS.map((option) => option.value).find((window) => {
    const dates = finderWindowDates(window, today);
    return (
      dates.windowStartDate === constraints.windowStartDate &&
      dates.windowEndDate === constraints.windowEndDate
    );
  });

export const finderBoundsOf = (constraints: FindSlotsConstraints): FinderBounds | undefined =>
  FINDER_BOUNDS.find((option) =>
    option.times
      ? option.times.earliestTime === constraints.earliestTime &&
        option.times.latestTime === constraints.latestTime
      : constraints.earliestTime === undefined && constraints.latestTime === undefined,
  )?.value;

export const finderDaysOf = (constraints: FindSlotsConstraints): FinderDays | undefined => {
  const chosen = constraints.daysOfWeek;
  return FINDER_DAYS.find((option) =>
    option.days
      ? chosen !== undefined &&
        chosen.length === option.days.length &&
        option.days.every((day) => chosen.includes(day))
      : chosen === undefined || chosen.length === 0,
  )?.value;
};
