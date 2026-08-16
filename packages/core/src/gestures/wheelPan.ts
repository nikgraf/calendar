/** Off-screen day columns rendered on each side of the visible days. */
export const PAN_BUFFER_DAYS = 2;

export interface WheelPanConfig {
  /** Silence (ms) between wheel events that separates two gestures. */
  readonly gestureGapMs: number;
}

const DEFAULT_CONFIG: WheelPanConfig = {
  gestureGapMs: 150,
};

/** deltaMode 1 (lines) ≈ 16px each, 2 (pages) ≈ 800px; trackpads report 0 (pixels). */
export const wheelDeltaToPx = (delta: number, deltaMode: number): number =>
  delta * (deltaMode === 1 ? 16 : deltaMode === 2 ? 800 : 1);

export interface PanFeedResult {
  /** Whole days to commit to app state now (positive = forward in time). */
  readonly commitDays: number;
  /** Whether the event belonged to a horizontal pan (else let it scroll). */
  readonly consumed: boolean;
  /** Raw strip offset in px to render, pre-compensation. */
  readonly offsetPx: number;
}

export interface WheelPan {
  /**
   * Re-anchors after the renderer committed `days`: the day strip's content
   * shifted by `days` columns, so the visual offset gains the same width
   * back. Returns the new offset to render.
   */
  readonly compensate: (days: number, dayWidthPx: number) => number;
  /** Feed one wheel event (px deltas, event timestamp). */
  readonly feed: (
    deltaXPx: number,
    deltaYPx: number,
    dayWidthPx: number,
    timeMs: number,
  ) => PanFeedResult;
  readonly offset: () => number;
  readonly pendingDays: () => number;
  /**
   * Ends the gesture: rounds the remaining offset to the nearest day and
   * returns the days to commit; the caller then animates the offset to 0.
   */
  readonly release: (dayWidthPx: number) => { readonly commitDays: number };
  readonly reset: () => void;
  /** Overwrites the offset — used by the settle animation's frames. */
  readonly setOffset: (offsetPx: number) => void;
}

/**
 * Continuous horizontal pan over a strip of day columns, fed by trackpad
 * wheel events. The strip follows the fingers 1:1 (`offsetPx`); every time
 * a full day width is crossed the pan emits a day commit so the app can
 * shift the rendered days, then re-anchors via `compensate`. The first
 * event of a gesture locks its axis, so vertical scrolling never pans and
 * a pan never scrolls.
 */
export const createWheelPan = (config: Partial<WheelPanConfig> = {}): WheelPan => {
  const { gestureGapMs } = { ...DEFAULT_CONFIG, ...config };
  let axis: 'horizontal' | 'vertical' | null = null;
  let offsetPx = 0;
  // Day commits emitted but not yet re-anchored by compensate().
  let pending = 0;
  let lastEventMs = Number.NEGATIVE_INFINITY;

  return {
    compensate: (days, dayWidthPx) => {
      offsetPx += days * dayWidthPx;
      pending -= days;
      return offsetPx;
    },
    feed: (deltaXPx, deltaYPx, dayWidthPx, timeMs) => {
      if (timeMs - lastEventMs > gestureGapMs) {
        axis = null;
      }
      lastEventMs = timeMs;
      axis ??= Math.abs(deltaXPx) > Math.abs(deltaYPx) ? 'horizontal' : 'vertical';
      if (axis === 'vertical' || dayWidthPx <= 0) {
        return { commitDays: 0, consumed: false, offsetPx };
      }
      offsetPx -= deltaXPx;
      // The offset as it will look once all pending commits are re-anchored.
      let virtual = offsetPx + pending * dayWidthPx;
      let commitDays = 0;
      while (virtual <= -dayWidthPx) {
        commitDays += 1;
        pending += 1;
        virtual += dayWidthPx;
      }
      while (virtual >= dayWidthPx) {
        commitDays -= 1;
        pending -= 1;
        virtual -= dayWidthPx;
      }
      return { commitDays, consumed: true, offsetPx };
    },
    offset: () => offsetPx,
    pendingDays: () => pending,
    release: (dayWidthPx) => {
      axis = null;
      if (dayWidthPx <= 0) {
        return { commitDays: 0 };
      }
      const virtual = offsetPx + pending * dayWidthPx;
      const commitDays = Math.round(-virtual / dayWidthPx);
      pending += commitDays;
      return { commitDays };
    },
    reset: () => {
      axis = null;
      offsetPx = 0;
      pending = 0;
      lastEventMs = Number.NEGATIVE_INFINITY;
    },
    setOffset: (value) => {
      offsetPx = value;
    },
  };
};
