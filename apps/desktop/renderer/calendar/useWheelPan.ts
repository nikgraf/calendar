import { createWheelPan, isOwnPanShift, Temporal, wheelDeltaToPx } from '@calendar/core';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

const GESTURE_GAP_MS = 150;
const SETTLE_MS = 200;

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

/** A slide to a picked day: quick for a column or two, longer the farther it travels. */
const slideMs = (days: number): number => Math.min(240 + 12 * days, 400);

const prefersReducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Continuous horizontal trackpad panning across days. The day strip follows
 * the fingers 1:1 via a `--pan-x` CSS variable written imperatively (no
 * React render per wheel event); crossing a full day width commits a day
 * shift to app state, and a layout effect re-anchors the offset before
 * paint when the shifted days arrive. When the wheel goes quiet the offset
 * snaps to the nearest day boundary with an ease-out animation.
 *
 * A picked first day (`slide` ≠ 0) arrives with the days it travels across
 * drawn on the side it comes from: the offset starts where the old days
 * sat and eases to 0, a scroll to the day. A pan grabs a slide mid-way.
 */
export const useWheelPan = ({
  enabled,
  firstDay,
  onCommitDays,
  onSlideEnd,
  rootRef,
  scrollerRef,
  slide,
  viewportRef,
  visibleDayCount,
}: {
  enabled: boolean;
  /** First visible day — day shifts are detected by watching it change. */
  firstDay: Temporal.PlainDate;
  onCommitDays: (dayCount: number) => void;
  /** The slide reached its day (or a pan took it over): the strip can drop the days it crossed. */
  onSlideEnd: () => void;
  /** Gets the wheel listener and the `--pan-x` variable. */
  rootRef: RefObject<HTMLElement | null>;
  /**
   * Vertical scroller: consumed (prevented) pan events apply their deltaY
   * here manually, so diagonal gestures scroll both dimensions at once.
   */
  scrollerRef: RefObject<HTMLElement | null>;
  /** Signed days a slide to the first day travels (0: none), drawn before (forward) or after it. */
  slide: number;
  /** Clipped strip container; its width / visibleDayCount = day width. */
  viewportRef: RefObject<HTMLElement | null>;
  visibleDayCount: number;
}): void => {
  const enabledRef = useRef(enabled);
  const onCommitDaysRef = useRef(onCommitDays);
  const onSlideEndRef = useRef(onSlideEnd);
  const visibleDayCountRef = useRef(visibleDayCount);
  useEffect(() => {
    enabledRef.current = enabled;
    onCommitDaysRef.current = onCommitDays;
    onSlideEndRef.current = onSlideEnd;
    visibleDayCountRef.current = visibleDayCount;
  }, [enabled, onCommitDays, onSlideEnd, visibleDayCount]);

  // One controller for the hook's lifetime: it closes over the (stable) ref
  // objects only, so the effects below have honest dependency arrays.
  const [controller] = useState(() => {
    const pan = createWheelPan({ gestureGapMs: GESTURE_GAP_MS });
    let releaseTimer: ReturnType<typeof setTimeout> | null = null;
    let settleFrame: number | null = null;
    // A release() committed days; the settle starts once they re-anchor.
    let awaitingSettle = false;
    // The running settle is a slide's: ending it ends the slide.
    let sliding = false;
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
      sliding = false;
    };
    const endSlide = () => {
      sliding = false;
      onSlideEndRef.current();
    };
    const startSettle = (durationMs = SETTLE_MS) => {
      cancelSettle();
      const from = pan.offset();
      if (Math.abs(from) < 0.5) {
        pan.setOffset(0);
        setVar(0);
        return;
      }
      const startedAt = performance.now();
      const frame = (nowMs: number) => {
        const t = Math.min((nowMs - startedAt) / durationMs, 1);
        const value = from * (1 - easeOutCubic(t));
        pan.setOffset(value);
        setVar(value);
        settleFrame = t < 1 ? requestAnimationFrame(frame) : null;
        if (t === 1 && sliding) {
          endSlide();
        }
      };
      settleFrame = requestAnimationFrame(frame);
    };
    const startSlide = (days: number) => {
      clearReleaseTimer();
      cancelSettle();
      pan.reset();
      if (prefersReducedMotion()) {
        setVar(0);
        endSlide();
        return;
      }
      // Before paint, the strip shows where the slide comes from: for a
      // nearby day, the days that were on screen, right where they were.
      pan.setOffset(days * dayWidth());
      setVar(pan.offset());
      startSettle(slideMs(Math.abs(days)));
      if (settleFrame === null) {
        // Nothing to animate (no width yet): the slide is over at once.
        endSlide();
      } else {
        sliding = true;
      }
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
      // A drag mid-slide keeps the slide's extra days drawn: dropping them
      // would move the drop target's day index under the pointer. The next
      // navigation clears them.
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
        // A pan grabbing a slide takes its offset as is (the settle frames
        // wrote it to the pan): its commits shift back over the slide's days.
        const grabbedSlide = sliding;
        cancelSettle();
        if (grabbedSlide) {
          onSlideEndRef.current();
        }
        setVar(result.offsetPx);
        if (result.commitDays !== 0) {
          onCommitDaysRef.current(result.commitDays);
        }
        clearReleaseTimer();
        releaseTimer = setTimeout(release, GESTURE_GAP_MS);
      },
      /**
       * Called before paint whenever the rendered day window changes:
       * re-anchors the offset for shifts this pan committed; a picked day
       * (`slide` set) slides in; any other navigation (buttons, Today, view
       * switch) resets the pan instead.
       */
      onDaysChanged: (firstIso: string, count: number, slide: number) => {
        const prev = previous;
        previous = { count, firstIso };
        if (!prev) {
          return;
        }
        const shiftedDays = Temporal.PlainDate.from(prev.firstIso).until(
          Temporal.PlainDate.from(firstIso),
        ).days;
        const ownShift = isOwnPanShift(shiftedDays, pan.pendingDays());
        if (prev.count === count && shiftedDays !== 0 && !ownShift && slide !== 0) {
          startSlide(slide);
          return;
        }
        if (prev.count !== count || (shiftedDays !== 0 && !ownShift)) {
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
    controller.onDaysChanged(firstDayIso, visibleDayCount, slide);
  }, [controller, firstDayIso, visibleDayCount, slide]);

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
