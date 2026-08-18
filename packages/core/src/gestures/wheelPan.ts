/** Off-screen day columns rendered on each side of the visible days. */
export const PAN_BUFFER_DAYS = 2;

export interface WheelPanConfig {
  /** Silence (ms) between wheel events that separates two gestures. */
  readonly gestureGapMs: number;
  /** Horizontal px (from horizontally dominant events) that starts a pan. */
  readonly intentThresholdPx: number;
}

const DEFAULT_CONFIG: WheelPanConfig = {
  gestureGapMs: 150,
  intentThresholdPx: 10,
};

/** deltaMode 1 (lines) ≈ 16px each, 2 (pages) ≈ 800px; trackpads report 0 (pixels). */
export const wheelDeltaToPx = (delta: number, deltaMode: number): number =>
  delta * (deltaMode === 1 ? 16 : deltaMode === 2 ? 800 : 1);

export interface PanFeedResult {
  /** Whole days to commit to app state now (positive = forward in time). */
  readonly commitDays: number;
  /**
   * Whether the event belongs to an active pan. Consumed events must be
   * prevented from native scrolling; the caller applies their deltaY to the
   * vertical scroller itself so diagonal panning scrolls both dimensions.
   */
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
 * shift the rendered days, then re-anchors via `compensate`.
 *
 * A pan engages once horizontally dominant events accumulate
 * `intentThresholdPx` within a gesture — there is deliberately no hard axis
 * lock: vertical scrolling never has to wait for a gesture gap, and while a
 * pan is active the caller keeps vertical deltas working by scrolling
 * manually, so the two dimensions stay simultaneously usable.
 */
export const createWheelPan = (config: Partial<WheelPanConfig> = {}): WheelPan => {
  const { gestureGapMs, intentThresholdPx } = { ...DEFAULT_CONFIG, ...config };
  let panning = false;
  let intentPx = 0;
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
        // Stale run-up from a previous gesture (release() ends the pan).
        intentPx = 0;
      }
      lastEventMs = timeMs;
      if (dayWidthPx <= 0) {
        return { commitDays: 0, consumed: false, offsetPx };
      }
      if (panning) {
        offsetPx -= deltaXPx;
      } else {
        // Horizontally dominant events build intent; a vertically dominant
        // one resets it, so drift during vertical scrolling never adds up.
        intentPx = Math.abs(deltaXPx) > Math.abs(deltaYPx) ? intentPx + deltaXPx : 0;
        if (Math.abs(intentPx) < intentThresholdPx) {
          return { commitDays: 0, consumed: false, offsetPx };
        }
        panning = true;
        // Apply the accumulated run-up (includes this event's deltaX).
        offsetPx -= intentPx;
        intentPx = 0;
      }
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
      panning = false;
      intentPx = 0;
      if (dayWidthPx <= 0) {
        return { commitDays: 0 };
      }
      const virtual = offsetPx + pending * dayWidthPx;
      const commitDays = Math.round(-virtual / dayWidthPx);
      pending += commitDays;
      return { commitDays };
    },
    reset: () => {
      panning = false;
      intentPx = 0;
      offsetPx = 0;
      pending = 0;
      lastEventMs = Number.NEGATIVE_INFINITY;
    },
    setOffset: (value) => {
      offsetPx = value;
    },
  };
};
