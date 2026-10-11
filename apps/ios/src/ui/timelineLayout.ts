/** Geometry shared by the timeline's columns, chips and the week header. */
export const HOUR_HEIGHT = 56;
/** 15 minutes. */
export const SNAP_PX = HOUR_HEIGHT / 4;
export const GUTTER_WIDTH = 56;
/**
 * The other zones stack under each hour, so the gutter only widens enough
 * for the city names over it.
 */
export const gutterWidth = (secondaryZoneCount: number): number =>
  secondaryZoneCount === 0 ? GUTTER_WIDTH : 64;
export const EDGE_INSET = 8;
/** One all-day chip row: a 20-pt chip plus the 4-pt gap below it. */
export const ALL_DAY_ROW_HEIGHT = 24;

export const pxToMinutes = (px: number): number => (px / HOUR_HEIGHT) * 60;
