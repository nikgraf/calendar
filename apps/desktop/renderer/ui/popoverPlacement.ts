/** How far a popover keeps from the window's top and bottom edges, in px. */
export const POPOVER_MARGIN = 8;

/**
 * A popover panel's top: under the opener when it fits, else above it
 * (when the caller gave the opener's top and there is room there), else
 * as low as the window allows. The settings window is fixed at 560 px, so
 * a picker under a low row would otherwise open past its bottom, out of
 * reach — its backdrop takes the wheel, so the pane cannot scroll it in.
 */
export const popoverTop = (
  anchor: { readonly above?: number | undefined; readonly y: number },
  height: number,
  viewportHeight: number,
): number => {
  const bottom = viewportHeight - POPOVER_MARGIN;
  if (anchor.y + height <= bottom) {
    return anchor.y;
  }
  if (anchor.above !== undefined && anchor.above - height >= POPOVER_MARGIN) {
    return anchor.above - height;
  }
  return Math.max(POPOVER_MARGIN, bottom - height);
};
