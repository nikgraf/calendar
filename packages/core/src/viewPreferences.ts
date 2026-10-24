import { Schema } from 'effect';

/** The main views; `twoDay` is iOS-only, `agenda` lists the next two weeks. */
export const CalendarViewKind = Schema.Literals(['agenda', 'day', 'month', 'twoDay', 'week']);
export type CalendarViewKind = typeof CalendarViewKind.Type;

/**
 * Device-local view preferences, stored in the device_settings table and
 * never synced: how this device likes its calendar drawn. One typed struct
 * rather than an rpc per toggle, so future per-device view choices extend
 * it without new methods. Only `allDayLaneCollapsed` travels in the
 * settings document; the other fields are device taste and stay here.
 */
export const ViewPreferences = Schema.Struct({
  /** The all-day lane caps at MAX_ALL_DAY_ROWS with "+N more" chips instead of growing. */
  allDayLaneCollapsed: Schema.Boolean,
  /** The view the calendar opens in; absent = the platform default. */
  lastView: Schema.optional(CalendarViewKind),
  /** Desktop: the sidebar is hidden. */
  sidebarCollapsed: Schema.optional(Schema.Boolean),
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
