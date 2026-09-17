import { minuteOfDay, slotFromDrag, slotTimes, type SlotRange, Temporal } from '@calendar/core';
import { useEffect, useRef, useState } from 'react';

const DRAG_THRESHOLD_PX = 4;

/** The slot being drawn, and the day column it is drawn in. */
export interface SlotSelection extends SlotRange {
  readonly day: Temporal.PlainDate;
}

interface SlotOrigin {
  active: boolean;
  readonly anchorMinute: number;
  readonly column: HTMLElement;
  readonly day: Temporal.PlainDate;
  readonly pointerId: number;
  readonly startClientY: number;
}

/**
 * Press on empty grid space and drag up or down to draw a new event's slot
 * (15-minute snap, one column); the release hands the slot to `onCreate`.
 * Only vertical travel counts toward the threshold: a click that drifts
 * sideways (a trackpad click often does) stays the column's hour click.
 * Presses on event blocks never arrive: the blocks stop propagation in
 * their own pointerdown (useEventDrag).
 */
export const useSlotDrag = ({
  hourHeight,
  onCreate,
}: {
  hourHeight: number;
  onCreate: (day: Temporal.PlainDate, times: { endTime: string; startTime: string }) => void;
}) => {
  const [selection, setSelection] = useState<SlotSelection | null>(null);
  const originRef = useRef<SlotOrigin | null>(null);
  // Suppresses the column's hour click that follows a drawn slot's release.
  const suppressClickRef = useRef(false);

  useEffect(() => {
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape' && originRef.current) {
        if (originRef.current.active) {
          // The abandoned release still clicks; keep it from opening the editor.
          suppressClickRef.current = true;
        }
        originRef.current = null;
        setSelection(null);
      }
    };
    // A release no column handled: the column the drag started in left the
    // page mid-drag (an arrow key or "t" navigated away), so its pointer
    // capture died with it. Column handlers run first and clear a live
    // drag; anything still here is stale.
    const onWindowPointerUp = () => {
      if (originRef.current) {
        originRef.current = null;
        setSelection(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowPointerUp);
    };
  }, []);

  /** Drops a drag whose column is gone; true when it did. */
  const dropIfDetached = (origin: SlotOrigin): boolean => {
    if (origin.column.isConnected) {
      return false;
    }
    originRef.current = null;
    setSelection(null);
    return true;
  };

  // The column rect is read per move: the grid can scroll mid-drag.
  const slotAt = (origin: SlotOrigin, clientY: number): SlotRange =>
    slotFromDrag(
      origin.anchorMinute,
      minuteOfDay(clientY - origin.column.getBoundingClientRect().top, hourHeight),
    );

  const onPointerDown = (day: Temporal.PlainDate, domEvent: React.PointerEvent<HTMLElement>) => {
    if (domEvent.button !== 0) {
      return;
    }
    const column = domEvent.currentTarget;
    // No text selection while drawing; the click still fires on release.
    domEvent.preventDefault();
    column.setPointerCapture(domEvent.pointerId);
    originRef.current = {
      active: false,
      anchorMinute: minuteOfDay(domEvent.clientY - column.getBoundingClientRect().top, hourHeight),
      column,
      day,
      pointerId: domEvent.pointerId,
      startClientY: domEvent.clientY,
    };
  };

  const onPointerMove = (domEvent: React.PointerEvent) => {
    const origin = originRef.current;
    if (!origin || origin.pointerId !== domEvent.pointerId || dropIfDetached(origin)) {
      return;
    }
    if (!origin.active && Math.abs(domEvent.clientY - origin.startClientY) < DRAG_THRESHOLD_PX) {
      return;
    }
    origin.active = true;
    const slot = slotAt(origin, domEvent.clientY);
    setSelection((current) =>
      current &&
      current.startMinute === slot.startMinute &&
      current.endMinute === slot.endMinute &&
      Temporal.PlainDate.compare(current.day, origin.day) === 0
        ? current
        : { ...slot, day: origin.day },
    );
  };

  const onPointerUp = (domEvent: React.PointerEvent) => {
    const origin = originRef.current;
    if (!origin || origin.pointerId !== domEvent.pointerId || dropIfDetached(origin)) {
      return;
    }
    originRef.current = null;
    // Judge by the release distance too: moves can be coalesced away under
    // load, and a fast flick can land press and release in one frame.
    const movedFar = Math.abs(domEvent.clientY - origin.startClientY) >= DRAG_THRESHOLD_PX;
    if (!origin.active && !movedFar) {
      return;
    }
    suppressClickRef.current = true;
    setSelection(null);
    onCreate(origin.day, slotTimes(slotAt(origin, domEvent.clientY)));
  };

  const onPointerCancel = () => {
    originRef.current = null;
    setSelection(null);
  };

  /** True exactly once after a release that drew a slot (or was cancelled). */
  const consumeSuppressedClick = (): boolean => {
    const suppressed = suppressClickRef.current;
    suppressClickRef.current = false;
    return suppressed;
  };

  return {
    consumeSuppressedClick,
    onPointerCancel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    /** The slot being drawn, or null. */
    selection,
  };
};
