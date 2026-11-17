/**
 * The launch times Settings › Advanced › Diagnostics shows: for each of
 * the last launches, how long it took to reach each step. A slow launch on
 * a phone (a restaurant without signal) leaves its record behind, steps it
 * never reached included (a launch closed before its JavaScript ran is
 * recorded by the next one, from the native side's start), so the next
 * look tells which step took the time. Pure: the file and the clocks are
 * `launchTiming.ts`'s.
 */

/** The steps of a launch, in the order a launch reaches them. */
export const LAUNCH_STEPS = ['script', 'firstFrame', 'calendar'] as const;
export type LaunchStep = (typeof LAUNCH_STEPS)[number];

const STEP_LABEL: Record<LaunchStep, string> = {
  calendar: 'calendar',
  firstFrame: 'first frame',
  script: 'JavaScript',
};

export interface LaunchRecord {
  /**
   * How long the process ran before `start`, for a launch counted from its
   * window: iOS prewarmed it or woke it in the background, or the launch
   * stalled before its window. Shown, so that a stall is never hidden.
   */
  readonly before?: number;
  /**
   * The launch's start, in milliseconds since 1970: its process's start,
   * or its window's for a process that was running before the tap.
   */
  readonly start: number;
  /** Milliseconds from the start to each step reached. */
  readonly steps: Partial<Record<LaunchStep, number>>;
}

/** How many launches the file keeps. */
export const KEPT_LAUNCHES = 10;

/** A launch that started at `start`, newest first, no step reached yet; the oldest falls off. */
export const addLaunch = (
  records: ReadonlyArray<LaunchRecord>,
  start: number,
  before?: number,
): ReadonlyArray<LaunchRecord> => [
  { ...(before === undefined ? {} : { before }), start, steps: {} },
  ...records.slice(0, KEPT_LAUNCHES - 1),
];

/** The newest launch with `step` reached at `at`; a step is taken once. */
export const reachStep = (
  records: ReadonlyArray<LaunchRecord>,
  step: LaunchStep,
  at: number,
): ReadonlyArray<LaunchRecord> => {
  const [newest, ...rest] = records;
  if (!newest || newest.steps[step] !== undefined) {
    return records;
  }
  return [
    { ...newest, steps: { ...newest.steps, [step]: Math.max(0, at - newest.start) } },
    ...rest,
  ];
};

const isRecord = (value: unknown): value is LaunchRecord => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { before, start, steps } = value as Record<string, unknown>;
  return (
    (before === undefined || typeof before === 'number') &&
    typeof start === 'number' &&
    typeof steps === 'object' &&
    steps !== null
  );
};

/** The file's records; anything unreadable reads as none. */
export const parseLaunches = (text: string): ReadonlyArray<LaunchRecord> => {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter(isRecord) : [];
  } catch {
    return [];
  }
};

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** A span that may be hours long: seconds under a minute, then minutes, then hours. */
const span = (ms: number): string => {
  if (ms < 60_000) {
    return seconds(ms);
  }
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${String(minutes)} min` : `${String(Math.round(minutes / 60))} h`;
};

/**
 * One launch as Diagnostics reads it: the time to each step reached, then
 * the first step it never reached ("no first frame": it was closed, or is
 * still on its way, before that), and how long its process had run before
 * a launch counted from its window.
 */
export const launchLine = (record: LaunchRecord): string => {
  const parts: Array<string> = [];
  for (const step of LAUNCH_STEPS) {
    const ms = record.steps[step];
    if (ms === undefined) {
      parts.push(`no ${STEP_LABEL[step]}`);
      break;
    }
    parts.push(`${STEP_LABEL[step]} ${seconds(ms)}`);
  }
  const line = parts.join(' · ');
  return record.before === undefined ? line : `${line} (running ${span(record.before)} before)`;
};

/** "Nov 17, 9:23:05 AM": when the launch began, seconds included to tell quick relaunches apart. */
export const launchTitle = (record: LaunchRecord, timeZone?: string): string =>
  new Date(record.start).toLocaleString('en-US', {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    second: '2-digit',
    ...(timeZone === undefined ? {} : { timeZone }),
  });

/** The time the launch took: to the calendar, or "—" for one that never drew it. */
export const launchTotal = (record: LaunchRecord): string => {
  const ms = record.steps.calendar;
  return ms === undefined ? '—' : seconds(ms);
};
