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
  readonly startClientX: number;
  readonly startClientY: number;
}

/**
 * Press on empty grid space and drag up or down to draw a new event's slot
 * (15-minute snap, one column); the release hands the slot to `onCreate`.
 * Below the movement threshold nothing happens here, so a plain click
 * stays the column's hour click. Presses on event blocks never arrive: the
 * blocks stop propagation in their own pointerdown (useEventDrag).
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
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
      startClientX: domEvent.clientX,
      startClientY: domEvent.clientY,
    };
  };

  const onPointerMove = (domEvent: React.PointerEvent) => {
    const origin = originRef.current;
    if (!origin || origin.pointerId !== domEvent.pointerId) {
      return;
    }
    if (
      !origin.active &&
      Math.hypot(domEvent.clientX - origin.startClientX, domEvent.clientY - origin.startClientY) <
        DRAG_THRESHOLD_PX
    ) {
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
    originRef.current = null;
    if (!origin || origin.pointerId !== domEvent.pointerId) {
      return;
    }
    // Judge by the release distance too: moves can be coalesced away under
    // load, and a fast flick can land press and release in one frame.
    const movedFar =
      Math.hypot(domEvent.clientX - origin.startClientX, domEvent.clientY - origin.startClientY) >=
      DRAG_THRESHOLD_PX;
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
