/** Geometry shared by the timeline's columns, chips and the week header. */
export const HOUR_HEIGHT = 56;
/** 15 minutes. */
export const SNAP_PX = HOUR_HEIGHT / 4;
export const GUTTER_WIDTH = 56;
export const EDGE_INSET = 8;
/** One all-day chip row: a 20-pt chip plus the 4-pt gap below it. */
export const ALL_DAY_ROW_HEIGHT = 24;
/** Rows the all-day lane grows to on its own; past that a "+N more" chip takes over. */
export const MAX_ALL_DAY_ROWS = 3;

export const pxToMinutes = (px: number): number => (px / HOUR_HEIGHT) * 60;
