import { useBackendMutations } from '@calendar/app-state';
import { moveEventTimes, resizeEventEnd, snapMinutes, type EventRecord } from '@calendar/core';
import { useEffect, useRef, useState, type RefObject } from 'react';

const DRAG_THRESHOLD_PX = 4;

export type DragMode = 'move' | 'resize';

export interface DragPreview {
  readonly deltaDays: number;
  readonly deltaMinutes: number;
  readonly eventKey: string;
  readonly mode: DragMode;
}

interface DragOrigin {
  active: boolean;
  readonly event: EventRecord;
  readonly eventKey: string;
  readonly mode: DragMode;
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startClientY: number;
}

const isDraggable = (event: EventRecord): boolean =>
  !event.isAllDay && !event.recurringEventId && !event.recurrence;

/**
 * Pointer-event drag for week/day event blocks: vertical movement shifts
 * time (15-minute snap), horizontal movement shifts days (move mode only),
 * the bottom edge resizes. Below the movement threshold a pointerup counts
 * as a click.
 */
export const useEventDrag = ({
  dayCount,
  gridRef,
  gutterWidth,
  hourHeight,
  onClick,
}: {
  dayCount: number;
  gridRef: RefObject<HTMLDivElement | null>;
  gutterWidth: number;
  hourHeight: number;
  onClick: (event: EventRecord) => void;
}) => {
  const { updateEvent } = useBackendMutations();
  const [preview, setPreview] = useState<DragPreview | null>(null);
  const originRef = useRef<DragOrigin | null>(null);
  // Suppresses the day column's slot-click that follows a drag's pointerup.
  const suppressClickRef = useRef(false);

  useEffect(() => {
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape' && originRef.current) {
        originRef.current = null;
        setPreview(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const deltasFor = (origin: DragOrigin, clientX: number, clientY: number) => {
    const deltaMinutes = snapMinutes(((clientY - origin.startClientY) / hourHeight) * 60);
    if (origin.mode === 'resize') {
      return { deltaDays: 0, deltaMinutes };
    }
    const grid = gridRef.current?.getBoundingClientRect();
    const dayWidth = grid ? (grid.width - gutterWidth) / dayCount : 0;
    const deltaDays = dayWidth > 0 ? Math.round((clientX - origin.startClientX) / dayWidth) : 0;
    return { deltaDays, deltaMinutes };
  };

  const onPointerDown = (
    event: EventRecord,
    eventKey: string,
    domEvent: React.PointerEvent,
    mode: DragMode,
  ) => {
    if (domEvent.button !== 0) {
      return;
    }
    domEvent.stopPropagation();
    if (!isDraggable(event)) {
      // Still allow click-through for recurring/all-day events.
      if (mode === 'move') {
        originRef.current = {
          active: false,
          event,
          eventKey,
          mode,
          pointerId: domEvent.pointerId,
          startClientX: domEvent.clientX,
          startClientY: domEvent.clientY,
        };
      }
      return;
    }
    domEvent.currentTarget.setPointerCapture(domEvent.pointerId);
    originRef.current = {
      active: false,
      event,
      eventKey,
      mode,
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
    if (!isDraggable(origin.event)) {
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
    setPreview({
      eventKey: origin.eventKey,
      mode: origin.mode,
      ...deltasFor(origin, domEvent.clientX, domEvent.clientY),
    });
  };

  const onPointerUp = (domEvent: React.PointerEvent) => {
    const origin = originRef.current;
    originRef.current = null;
    if (!origin || origin.pointerId !== domEvent.pointerId) {
      return;
    }
    if (!origin.active) {
      setPreview(null);
      if (origin.mode === 'move') {
        onClick(origin.event);
      }
      suppressClickRef.current = true;
      return;
    }
    suppressClickRef.current = true;
    setPreview(null);

    const { deltaDays, deltaMinutes } = deltasFor(origin, domEvent.clientX, domEvent.clientY);
    if (deltaMinutes === 0 && deltaDays === 0) {
      return;
    }
    const changes =
      origin.mode === 'move'
        ? moveEventTimes(origin.event, deltaMinutes, deltaDays)
        : resizeEventEnd(origin.event, deltaMinutes);
    void updateEvent({
      accountId: origin.event.accountId,
      calendarId: origin.event.calendarId,
      changes,
      eventId: origin.event.id,
    });
  };

  /** True exactly once after a pointerup that should not become a slot click. */
  const consumeSuppressedClick = (): boolean => {
    const suppressed = suppressClickRef.current;
    suppressClickRef.current = false;
    return suppressed;
  };

  return {
    consumeSuppressedClick,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    preview,
  };
};
