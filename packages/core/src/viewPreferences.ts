import { Schema } from 'effect';

/**
 * Device-local view preferences, stored in the device_settings table and
 * never synced: how this device likes its calendar drawn. One typed struct
 * rather than an rpc per toggle, so future per-device view choices extend
 * it without new methods.
 */
export const ViewPreferences = Schema.Struct({
  /** The all-day lane caps at MAX_ALL_DAY_ROWS with "+N more" chips instead of growing. */
  allDayLaneCollapsed: Schema.Boolean,
});
export type ViewPreferences = typeof ViewPreferences.Type;

export const DEFAULT_VIEW_PREFERENCES: ViewPreferences = { allDayLaneCollapsed: false };

/** Rows the all-day lane shows while collapsed; the last one hosts "+N more" where a day overflows. */
export const MAX_ALL_DAY_ROWS = 3;
