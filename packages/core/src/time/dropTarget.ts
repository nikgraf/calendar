import { DRAG_SNAP_MINUTES } from './dragMath.ts';

/** Where a dragged task chip would land: a day in the all-day lane, or a day and minute in the grid. */
export type DropTarget =
  | { readonly dayIndex: number; readonly kind: 'allDay' }
  | { readonly dayIndex: number; readonly kind: 'timed'; readonly minute: number };

/** The lane and grid geometry a pointer position is judged against, in one coordinate space. */
export interface DropGeometry {
  readonly columnWidth: number;
  readonly dayCount: number;
  /** The visible grid viewport's vertical extent (the scroller on desktop, the ScrollView on iOS). */
  readonly grid: { readonly bottom: number; readonly top: number };
  /** Where minute 0 of the grid content sits: the viewport top minus the scroll offset. */
  readonly gridContentTop: number;
  readonly hourHeight: number;
  /** The all-day lane's vertical extent. */
  readonly lane: { readonly bottom: number; readonly top: number };
  /** x of the strip's first column, the live pan offset included. */
  readonly stripLeft: number;
}

const DAY_MINUTES = 24 * 60;
const LAST_SLOT_MINUTE = DAY_MINUTES - DRAG_SNAP_MINUTES;

/**
 * Maps a pointer position to a drop target: the day column under x (clamped
 * to the strip; its off-screen buffer columns are real days, reachable the
 * way a block dragged past the edge reaches them) and, in the grid, the
 * minute under y snapped to the drag step. Outside both the lane and the
 * grid viewport there is no target. A worklet: iOS calls it from the
 * gesture's UI-thread callbacks.
 */
export const dropTargetAt = (x: number, y: number, geometry: DropGeometry): DropTarget | null => {
  'worklet';
  if (geometry.columnWidth <= 0 || geometry.dayCount <= 0) {
    return null;
  }
  const dayIndex = Math.min(
    Math.max(Math.floor((x - geometry.stripLeft) / geometry.columnWidth), 0),
    geometry.dayCount - 1,
  );
  if (y >= geometry.lane.top && y < geometry.lane.bottom) {
    return { dayIndex, kind: 'allDay' };
  }
  if (y >= geometry.grid.top && y < geometry.grid.bottom && geometry.hourHeight > 0) {
    const raw = ((y - geometry.gridContentTop) / geometry.hourHeight) * 60;
    const snapped = Math.round(raw / DRAG_SNAP_MINUTES) * DRAG_SNAP_MINUTES;
    return { dayIndex, kind: 'timed', minute: Math.min(Math.max(snapped, 0), LAST_SLOT_MINUTE) };
  }
  return null;
};
