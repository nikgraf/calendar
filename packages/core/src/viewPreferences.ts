import { Schema } from 'effect';
import { sortWeekdays, Weekday, WEEKDAYS_MONDAY_FIRST } from './recurrence/byDay.ts';
import type { Temporal } from './time/temporal.ts';

/** The main views; `twoDay` is iOS-only, `agenda` lists the next two weeks. */
export const CalendarViewKind = Schema.Literals(['agenda', 'day', 'month', 'twoDay', 'week']);
export type CalendarViewKind = typeof CalendarViewKind.Type;

/**
 * Device-local view preferences, stored in the device_settings table: how
 * this device likes its calendar drawn. One typed struct rather than an
 * rpc per toggle, so future per-device view choices extend it without new
 * methods. The lane cap and the weekend travel in the settings document
 * (`PortableViewPreferences`); the opening view and the sidebar are device
 * taste and stay here.
 */
export const ViewPreferences = Schema.Struct({
  /** The all-day lane caps at MAX_ALL_DAY_ROWS with "+N more" chips instead of growing. */
  allDayLaneCollapsed: Schema.Boolean,
  /** The view the calendar opens in; absent = the platform default. */
  lastView: Schema.optional(CalendarViewKind),
  /** Desktop: the sidebar is hidden. */
  sidebarCollapsed: Schema.optional(Schema.Boolean),
  /** The days the grids draw as the weekend, Monday first; absent = DEFAULT_WEEKEND_DAYS. */
  weekendDays: Schema.optional(Schema.Array(Weekday)),
  /** Weekend days get their own background in the grids; absent = on. */
  weekendShading: Schema.optional(Schema.Boolean),
});
export type ViewPreferences = typeof ViewPreferences.Type;

export const DEFAULT_VIEW_PREFERENCES: ViewPreferences = { allDayLaneCollapsed: false };

/** Rows the all-day lane shows while collapsed; the last one hosts "+N more" where a day overflows. */
export const MAX_ALL_DAY_ROWS = 3;

/** The share of the calendar's height an expanded all-day lane may take before it scrolls. */
const EXPANDED_LANE_SHARE = 1 / 3;

/**
 * Whole rows an expanded all-day lane shows before it scrolls inside
 * itself: a third of the calendar's height (header to bottom), never
 * fewer than the collapsed lane's MAX_ALL_DAY_ROWS. Each app stops a
 * taller lane partway into the next chip, so the cut says there is more,
 * and the timed grid keeps the rest of the view.
 */
export const expandedAllDayRows = (viewHeight: number, rowHeight: number): number =>
  Math.max(MAX_ALL_DAY_ROWS, Math.floor((viewHeight * EXPANDED_LANE_SHARE) / rowHeight));

/**
 * Saturday and Sunday. Weekends differ by country (Friday and Saturday in
 * much of the Middle East), but the app reads no region: the days are the
 * user's to pick, once, and travel with the settings document.
 */
export const DEFAULT_WEEKEND_DAYS: ReadonlyArray<Weekday> = ['SA', 'SU'];

/** The weekdays the grids shade: none while shading is off. Test a date with `isShadedDay`. */
export const shadedWeekdays = (preferences: ViewPreferences): ReadonlySet<Weekday> =>
  new Set(
    preferences.weekendShading === false ? [] : (preferences.weekendDays ?? DEFAULT_WEEKEND_DAYS),
  );

/** Whether a grid draws `date` with the weekend background. */
export const isShadedDay = (shaded: ReadonlySet<Weekday>, date: Temporal.PlainDate): boolean =>
  shaded.has(WEEKDAYS_MONDAY_FIRST[date.dayOfWeek - 1]!);

/**
 * The settings document's `view` section: the preferences that travel.
 * Every field is optional so a hand-edited file can hold any of them; an
 * import applies the ones present.
 */
export const PortableViewPreferences = Schema.Struct({
  allDayLaneCollapsed: Schema.optional(Schema.Boolean),
  weekendDays: Schema.optional(Schema.Array(Weekday)),
  weekendShading: Schema.optional(Schema.Boolean),
});
export type PortableViewPreferences = typeof PortableViewPreferences.Type;

/** What an export writes: every travelling field, defaults filled in, days Monday first. */
export const portableViewPreferences = (
  preferences: ViewPreferences,
): Required<PortableViewPreferences> => ({
  allDayLaneCollapsed: preferences.allDayLaneCollapsed,
  weekendDays: sortWeekdays(preferences.weekendDays ?? DEFAULT_WEEKEND_DAYS),
  weekendShading: preferences.weekendShading ?? true,
});

/** `current` with the fields `incoming` holds; the device-local ones stay as they are. */
export const withPortableViewPreferences = (
  current: ViewPreferences,
  incoming: PortableViewPreferences,
): ViewPreferences => ({
  ...current,
  ...(incoming.allDayLaneCollapsed === undefined
    ? {}
    : { allDayLaneCollapsed: incoming.allDayLaneCollapsed }),
  ...(incoming.weekendDays === undefined
    ? {}
    : { weekendDays: sortWeekdays(incoming.weekendDays) }),
  ...(incoming.weekendShading === undefined ? {} : { weekendShading: incoming.weekendShading }),
});
