/** Geometry shared by the timeline's columns, chips and the week header. */
export const HOUR_HEIGHT = 56;
/** 15 minutes. */
export const SNAP_PX = HOUR_HEIGHT / 4;
export const GUTTER_WIDTH = 56;
/** The gutter widens once it lists other zones under each hour ("7 AM · 11 PM"). */
export const gutterWidth = (secondaryZoneCount: number): number =>
  secondaryZoneCount === 0 ? GUTTER_WIDTH : secondaryZoneCount === 1 ? 76 : 104;
export const EDGE_INSET = 8;
/** One all-day chip row: a 20-pt chip plus the 4-pt gap below it. */
export const ALL_DAY_ROW_HEIGHT = 24;

export const pxToMinutes = (px: number): number => (px / HOUR_HEIGHT) * 60;
