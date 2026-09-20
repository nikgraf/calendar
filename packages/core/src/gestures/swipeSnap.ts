export interface SwipeSnapConfig {
  /** Fraction of a column past which a release advances a day. */
  readonly commitFraction: number;
  /** Flick speed (px/s) that advances regardless of distance. */
  readonly commitVelocity: number;
  /** Below this travel nothing commits, however fast the flick. */
  readonly minTranslationPx: number;
}

const DEFAULT_CONFIG: SwipeSnapConfig = {
  commitFraction: 0.25,
  commitVelocity: 500,
  minTranslationPx: 8,
};

/**
 * Decides what a released horizontal swipe should do: advance a day (+1
 * forward, -1 back) or spring back (0). Dragging left reveals the next day,
 * matching natural scrolling.
 */
export const swipeSnapDecision = (
  translationPx: number,
  velocityPxPerSecond: number,
  columnWidthPx: number,
  config: Partial<SwipeSnapConfig> = {},
): -1 | 0 | 1 => {
  // Callable from a reanimated gesture callback on the UI thread; a plain
  // function cannot cross that boundary. Inert everywhere else.
  'worklet';
  const { commitFraction, commitVelocity, minTranslationPx } = { ...DEFAULT_CONFIG, ...config };
  if (columnWidthPx <= 0 || translationPx === 0) {
    return 0;
  }
  const travel = Math.abs(translationPx);
  const advance =
    travel > columnWidthPx * commitFraction ||
    (Math.abs(velocityPxPerSecond) > commitVelocity && travel > minTranslationPx);
  if (!advance) {
    return 0;
  }
  return translationPx < 0 ? 1 : -1;
};

/**
 * How many columns a released pan commits when the strip tracks the finger
 * across several: the whole columns crossed plus `swipeSnapDecision` on the
 * remainder (a flick still advances one more), clamped to `maxColumns` —
 * the drawn buffer, beyond which there is nothing to reveal. With one
 * column per page this is exactly `swipeSnapDecision`.
 */
export const swipeCommitColumns = (
  translationPx: number,
  velocityPxPerSecond: number,
  columnWidthPx: number,
  maxColumns: number,
  config: Partial<SwipeSnapConfig> = {},
): number => {
  'worklet';
  if (columnWidthPx <= 0 || maxColumns <= 0) {
    return 0;
  }
  // Dragging left reveals later columns: whole columns crossed, sign flipped.
  const whole = Math.trunc(-translationPx / columnWidthPx);
  const remainder = translationPx + whole * columnWidthPx;
  const extra = swipeSnapDecision(remainder, velocityPxPerSecond, columnWidthPx, config);
  return Math.max(-maxColumns, Math.min(maxColumns, whole + extra));
};
