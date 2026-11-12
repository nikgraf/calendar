/**
 * The form's floating pills (the steps, the way back to the Assistant)
 * get out of the way while the form is scrolled down and come back on a
 * scroll up, as a browser's toolbar does: what a scroll just brought up
 * from under them is in reach at once, and the pills are a short flick
 * away. `anchor` is the furthest the scroll went in the direction that
 * would flip them back — the lowest offset while they show, the highest
 * while they are tucked — so a flip takes a real change of direction,
 * not a finger that wavers.
 */
export interface PillTuck {
  readonly anchor: number;
  readonly tucked: boolean;
}

export const PILLS_SHOWN: PillTuck = { anchor: 0, tucked: false };

/** How far against the anchor a scroll must go before the pills flip. */
export const TUCK_DISTANCE = 24;

/**
 * The pills after the form scrolled to `offset`, of at most `max` (the
 * content's height less the view's). A bounce past either end is no
 * direction: the offset is read within the ends. At the top the pills
 * always show; a form that cannot scroll never tucks them.
 */
export const pillTuckAfter = (state: PillTuck, offset: number, max: number): PillTuck => {
  const y = Math.min(Math.max(offset, 0), Math.max(max, 0));
  if (y === 0) {
    return PILLS_SHOWN;
  }
  if (state.tucked) {
    const anchor = Math.max(state.anchor, y);
    return anchor - y > TUCK_DISTANCE ? { anchor: y, tucked: false } : { anchor, tucked: true };
  }
  const anchor = Math.min(state.anchor, y);
  return y - anchor > TUCK_DISTANCE ? { anchor: y, tucked: true } : { anchor, tucked: false };
};
