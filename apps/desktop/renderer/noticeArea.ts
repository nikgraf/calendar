/** A horizontal span of the window, in CSS pixels from its left edge. */
export interface Span {
  readonly left: number;
  readonly right: number;
}

/**
 * The narrowest the calendar's notices are laid out: 22rem, room for the
 * conflict banner's Yours / Google's table and its two buttons.
 */
export const NOTICE_MIN_WIDTH = 352;

/**
 * Where the calendar's notices go, given the grid's column: the column
 * itself while it is at least `min` wide (undefined). A narrower column —
 * the sidebar and the editor open in a small window — left the banner a
 * few pixels, its table and buttons spilling over the editor. Then the
 * notices take `min` ending at the column's right edge, reaching over the
 * sidebar but not the panel; and when even everything left of the panel is
 * narrower than that, `min` from the window's left edge, into the panel as
 * little as it must: its Cancel and Save sit at its right edge.
 */
export const noticeArea = (
  column: Span,
  windowWidth: number,
  min = NOTICE_MIN_WIDTH,
): Span | undefined => {
  if (column.right - column.left >= min) {
    return undefined;
  }
  if (column.right >= min) {
    return { left: column.right - min, right: column.right };
  }
  return { left: 0, right: Math.min(min, windowWidth) };
};
