import { createWheelPan, Temporal, wheelDeltaToPx } from '@calendar/core';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

const GESTURE_GAP_MS = 150;
const SETTLE_MS = 200;

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

/**
 * Continuous horizontal trackpad panning across days. The day strip follows
 * the fingers 1:1 via a `--pan-x` CSS variable written imperatively (no
 * React render per wheel event); crossing a full day width commits a day
 * shift to app state, and a layout effect re-anchors the offset before
 * paint when the shifted days arrive. When the wheel goes quiet the offset
 * snaps to the nearest day boundary with an ease-out animation.
 */
export const useWheelPan = ({
  enabled,
  firstDay,
  onCommitDays,
  rootRef,
  scrollerRef,
  viewportRef,
  visibleDayCount,
}: {
  enabled: boolean;
  /** First visible day — day shifts are detected by watching it change. */
  firstDay: Temporal.PlainDate;
  onCommitDays: (dayCount: number) => void;
  /** Gets the wheel listener and the `--pan-x` variable. */
  rootRef: RefObject<HTMLElement | null>;
  /**
   * Vertical scroller: consumed (prevented) pan events apply their deltaY
   * here manually, so diagonal gestures scroll both dimensions at once.
   */
  scrollerRef: RefObject<HTMLElement | null>;
  /** Clipped strip container; its width / visibleDayCount = day width. */
  viewportRef: RefObject<HTMLElement | null>;
  visibleDayCount: number;
}): void => {
  const enabledRef = useRef(enabled);
  const onCommitDaysRef = useRef(onCommitDays);
  const visibleDayCountRef = useRef(visibleDayCount);
  useEffect(() => {
    enabledRef.current = enabled;
    onCommitDaysRef.current = onCommitDays;
    visibleDayCountRef.current = visibleDayCount;
  }, [enabled, onCommitDays, visibleDayCount]);

  // One controller for the hook's lifetime: it closes over the (stable) ref
  // objects only, so the effects below have honest dependency arrays.
  const [controller] = useState(() => {
    const pan = createWheelPan({ gestureGapMs: GESTURE_GAP_MS });
    let releaseTimer: ReturnType<typeof setTimeout> | null = null;
    let settleFrame: number | null = null;
    // A release() committed days; the settle starts once they re-anchor.
    let awaitingSettle = false;
    let previous: { count: number; firstIso: string } | null = null;

    const setVar = (px: number) => {
      rootRef.current?.style.setProperty('--pan-x', `${px}px`);
    };
    const dayWidth = (): number =>
      (viewportRef.current?.clientWidth ?? 0) / visibleDayCountRef.current;
    const clearReleaseTimer = () => {
      if (releaseTimer !== null) {
        clearTimeout(releaseTimer);
        releaseTimer = null;
      }
    };
    const cancelSettle = () => {
      if (settleFrame !== null) {
        cancelAnimationFrame(settleFrame);
        settleFrame = null;
      }
      awaitingSettle = false;
    };
    const startSettle = () => {
      cancelSettle();
      const from = pan.offset();
      if (Math.abs(from) < 0.5) {
        pan.setOffset(0);
        setVar(0);
        return;
      }
      const startedAt = performance.now();
      const frame = (nowMs: number) => {
        const t = Math.min((nowMs - startedAt) / SETTLE_MS, 1);
        const value = from * (1 - easeOutCubic(t));
        pan.setOffset(value);
        setVar(value);
        settleFrame = t < 1 ? requestAnimationFrame(frame) : null;
      };
      settleFrame = requestAnimationFrame(frame);
    };
    const release = () => {
      releaseTimer = null;
      const { commitDays } = pan.release(dayWidth());
      if (commitDays !== 0) {
        // The settle starts from onDaysChanged once the shift re-anchors.
        awaitingSettle = true;
        onCommitDaysRef.current(commitDays);
      } else {
        startSettle();
      }
    };

    return {
      disable: () => {
        clearReleaseTimer();
        cancelSettle();
        pan.reset();
        setVar(0);
      },
      dispose: () => {
        clearReleaseTimer();
        cancelSettle();
      },
      handleWheel: (event: WheelEvent) => {
        if (!enabledRef.current) {
          return;
        }
        const result = pan.feed(
          wheelDeltaToPx(event.deltaX, event.deltaMode),
          wheelDeltaToPx(event.deltaY, event.deltaMode),
          dayWidth(),
          event.timeStamp,
        );
        if (!result.consumed) {
          return;
        }
        event.preventDefault();
        // preventDefault kills native scrolling for this event, so apply its
        // vertical component by hand — diagonal pans scroll both dimensions.
        const deltaY = wheelDeltaToPx(event.deltaY, event.deltaMode);
        if (deltaY !== 0 && scrollerRef.current) {
          scrollerRef.current.scrollTop += deltaY;
        }
        cancelSettle();
        setVar(result.offsetPx);
        if (result.commitDays !== 0) {
          onCommitDaysRef.current(result.commitDays);
        }
        clearReleaseTimer();
        releaseTimer = setTimeout(release, GESTURE_GAP_MS);
      },
      /**
       * Called before paint whenever the rendered day window changes:
       * re-anchors the offset for shifts this pan committed; any external
       * navigation (buttons, Today, view switch) resets the pan instead.
       */
      onDaysChanged: (firstIso: string, count: number) => {
        const prev = previous;
        previous = { count, firstIso };
        if (!prev) {
          return;
        }
        const shiftedDays = Temporal.PlainDate.from(prev.firstIso).until(
          Temporal.PlainDate.from(firstIso),
        ).days;
        if (prev.count !== count || (shiftedDays !== 0 && pan.pendingDays() === 0)) {
          cancelSettle();
          pan.reset();
          setVar(0);
          return;
        }
        if (shiftedDays === 0) {
          return;
        }
        setVar(pan.compensate(shiftedDays, dayWidth()));
        if (awaitingSettle && pan.pendingDays() === 0) {
          awaitingSettle = false;
          startSettle();
        }
      },
    };
  });

  const firstDayIso = firstDay.toString();
  useLayoutEffect(() => {
    controller.onDaysChanged(firstDayIso, visibleDayCount);
  }, [controller, firstDayIso, visibleDayCount]);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) {
      return;
    }
    // Native non-passive listener: React's delegated onWheel is passive, so
    // preventDefault() (stops horizontal rubber-band/history swipe) needs it.
    element.addEventListener('wheel', controller.handleWheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', controller.handleWheel);
      controller.dispose();
    };
  }, [controller, rootRef]);

  // A drag taking over mid-pan freezes the strip; drop the pan outright.
  useEffect(() => {
    if (!enabled) {
      controller.disable();
    }
  }, [controller, enabled]);
};
