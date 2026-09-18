import { useGuardedMutations } from '@calendar/app-state';
import {
  moveEventTimes,
  moveTimedTask,
  resizeEventEnd,
  snapMinutes,
  type EventRecord,
  type TaskRecord,
} from '@calendar/core';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

const DRAG_THRESHOLD_PX = 4;

export type DragMode = 'move' | 'resize';

/** Which block is being dragged, and how. Changes twice per drag. */
export interface DragPreview {
  readonly itemKey: string;
  readonly mode: DragMode;
}

/** The live offsets of that drag. Published per pointermove, outside React state. */
export interface DragDeltas {
  readonly deltaDays: number;
  readonly deltaMinutes: number;
}

const NO_DELTAS: DragDeltas = { deltaDays: 0, deltaMinutes: 0 };

interface DragOrigin {
  active: boolean;
  readonly itemKey: string;
  readonly mode: DragMode;
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly target:
    | { readonly event: EventRecord; readonly kind: 'event' }
    | { readonly kind: 'task'; readonly readOnly: boolean; readonly task: TaskRecord };
}

// Recurring instances are draggable too — a drag commits a single-instance
// override, like Fantastical. Only all-day chips stay fixed.
const isDraggable = (origin: DragOrigin): boolean =>
  origin.target.kind === 'event'
    ? !origin.target.event.isAllDay && !origin.target.event.recurrence
    : !origin.target.readOnly;

/**
 * Pointer-event drag for week/day event blocks: vertical movement shifts
 * time (15-minute snap), horizontal movement shifts days (move mode only),
 * the bottom edge resizes. Below the movement threshold a pointerup counts
 * as a click.
 *
 * Only `preview` (which block, which mode) is React state; the per-move
 * offsets go through a tiny external store so the dragged block alone
 * re-renders per pointermove — the grid used to re-lay out every column on
 * each one.
 */
export const useEventDrag = ({
  dayCount,
  gridRef,
  hourHeight,
  onEventClick,
  onTaskClick,
  timeZone,
}: {
  dayCount: number;
  gridRef: RefObject<HTMLDivElement | null>;
  hourHeight: number;
  onEventClick: (event: EventRecord) => void;
  onTaskClick: (task: TaskRecord) => void;
  timeZone: string;
}) => {
  const { updateEvent, updateRecurring, updateTask } = useGuardedMutations();
  const [preview, setPreview] = useState<DragPreview | null>(null);
  const originRef = useRef<DragOrigin | null>(null);
  const deltasRef = useRef<DragDeltas>(NO_DELTAS);
  const activeItemKeyRef = useRef<string | null>(null);
  const listenersRef = useRef(new Map<string, Set<() => void>>());
  const publishDeltas = (next: DragDeltas) => {
    const current = deltasRef.current;
    if (current.deltaDays === next.deltaDays && current.deltaMinutes === next.deltaMinutes) {
      return;
    }
    deltasRef.current = next;
    const activeListeners =
      activeItemKeyRef.current === null
        ? undefined
        : listenersRef.current.get(activeItemKeyRef.current);
    for (const listener of activeListeners ?? []) {
      listener();
    }
  };
  const subscribeDeltas = useCallback((itemKey: string, listener: () => void) => {
    const listeners = listenersRef.current.get(itemKey) ?? new Set<() => void>();
    listeners.add(listener);
    listenersRef.current.set(itemKey, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        listenersRef.current.delete(itemKey);
      }
    };
  }, []);
  const getDeltas = useCallback(() => deltasRef.current, []);
  // Suppresses the day column's slot-click that follows a drag's pointerup.
  const suppressClickRef = useRef(false);

  useEffect(() => {
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape' && originRef.current) {
        // The abandoned pointerup still emits a click — keep it from
        // falling through to the day column's slot-click.
        if (originRef.current.active) {
          suppressClickRef.current = true;
        }
        originRef.current = null;
        setPreview(null);
        publishDeltas(NO_DELTAS);
        activeItemKeyRef.current = null;
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
    const dayWidth = grid ? grid.width / dayCount : 0;
    const deltaDays = dayWidth > 0 ? Math.round((clientX - origin.startClientX) / dayWidth) : 0;
    return { deltaDays, deltaMinutes };
  };

  const onPointerDown = (
    event: EventRecord,
    itemKey: string,
    domEvent: React.PointerEvent,
    mode: DragMode,
  ) => {
    if (domEvent.button !== 0) {
      return;
    }
    domEvent.stopPropagation();
    const origin: DragOrigin = {
      active: false,
      itemKey,
      mode,
      pointerId: domEvent.pointerId,
      startClientX: domEvent.clientX,
      startClientY: domEvent.clientY,
      target: { event, kind: 'event' },
    };
    if (!isDraggable(origin)) {
      // Still allow click-through for recurring/all-day events.
      if (mode === 'move') {
        originRef.current = {
          active: false,
          itemKey,
          mode,
          pointerId: domEvent.pointerId,
          startClientX: domEvent.clientX,
          startClientY: domEvent.clientY,
          target: { event, kind: 'event' },
        };
      }
      return;
    }
    domEvent.currentTarget.setPointerCapture(domEvent.pointerId);
    originRef.current = {
      active: false,
      itemKey,
      mode,
      pointerId: domEvent.pointerId,
      startClientX: domEvent.clientX,
      startClientY: domEvent.clientY,
      target: { event, kind: 'event' },
    };
  };

  const onTaskPointerDown = (
    task: TaskRecord,
    itemKey: string,
    readOnly: boolean,
    domEvent: React.PointerEvent,
  ) => {
    if (domEvent.button !== 0) {
      return;
    }
    domEvent.stopPropagation();
    const origin: DragOrigin = {
      active: false,
      itemKey,
      mode: 'move',
      pointerId: domEvent.pointerId,
      startClientX: domEvent.clientX,
      startClientY: domEvent.clientY,
      target: { kind: 'task', readOnly, task },
    };
    // Capture read-only drags too: movement is discarded below, but must not
    // fall through to the empty-grid slot gesture.
    domEvent.currentTarget.setPointerCapture(domEvent.pointerId);
    originRef.current = origin;
  };

  const onPointerMove = (domEvent: React.PointerEvent) => {
    const origin = originRef.current;
    if (!origin || origin.pointerId !== domEvent.pointerId) {
      return;
    }
    if (!isDraggable(origin)) {
      return;
    }
    if (
      !origin.active &&
      Math.hypot(domEvent.clientX - origin.startClientX, domEvent.clientY - origin.startClientY) <
        DRAG_THRESHOLD_PX
    ) {
      return;
    }
    if (!origin.active) {
      origin.active = true;
      activeItemKeyRef.current = origin.itemKey;
      setPreview({ itemKey: origin.itemKey, mode: origin.mode });
    }
    publishDeltas(deltasFor(origin, domEvent.clientX, domEvent.clientY));
  };

  const onPointerCancel = (domEvent: React.PointerEvent) => {
    const origin = originRef.current;
    if (!origin || origin.pointerId !== domEvent.pointerId) {
      return;
    }
    if (origin.active) {
      suppressClickRef.current = true;
    }
    originRef.current = null;
    setPreview(null);
    publishDeltas(NO_DELTAS);
    activeItemKeyRef.current = null;
  };

  const onPointerUp = (domEvent: React.PointerEvent) => {
    const origin = originRef.current;
    originRef.current = null;
    if (!origin || origin.pointerId !== domEvent.pointerId) {
      return;
    }
    // `active` is only ever set from pointermove, and moves can be missed
    // entirely — the browser coalesces them under load, and a fast flick can
    // land press and release in one frame. Judge by the release distance so
    // such a gesture still moves the event instead of silently becoming a
    // click that opens the editor.
    const movedFar =
      Math.hypot(domEvent.clientX - origin.startClientX, domEvent.clientY - origin.startClientY) >=
      DRAG_THRESHOLD_PX;
    if (!origin.active && !movedFar) {
      setPreview(null);
      publishDeltas(NO_DELTAS);
      activeItemKeyRef.current = null;
      if (origin.mode === 'move') {
        if (origin.target.kind === 'event') {
          onEventClick(origin.target.event);
        } else {
          onTaskClick(origin.target.task);
        }
      }
      suppressClickRef.current = true;
      return;
    }
    suppressClickRef.current = true;
    setPreview(null);
    publishDeltas(NO_DELTAS);
    activeItemKeyRef.current = null;

    if (!isDraggable(origin)) {
      return;
    }

    const { deltaDays, deltaMinutes } = deltasFor(origin, domEvent.clientX, domEvent.clientY);
    if (deltaMinutes === 0 && deltaDays === 0) {
      return;
    }
    if (origin.target.kind === 'task') {
      const task = origin.target.task;
      const changes = moveTimedTask(task, timeZone, deltaMinutes, deltaDays);
      if (!changes) {
        return;
      }
      void updateTask({
        accountId: task.accountId,
        changes,
        taskId: task.id,
        taskListId: task.listId,
      });
      return;
    }
    const event = origin.target.event;
    const changes =
      origin.mode === 'move'
        ? moveEventTimes(event, deltaMinutes, deltaDays)
        : resizeEventEnd(event, deltaMinutes);
    if (event.recurringEventId) {
      void updateRecurring({
        accountId: event.accountId,
        calendarId: event.calendarId,
        changes,
        masterId: event.recurringEventId,
        originalStartUtc: event.originalStartUtc ?? event.startUtc,
        scope: 'instance',
      });
    } else {
      void updateEvent({
        accountId: event.accountId,
        calendarId: event.calendarId,
        changes,
        eventId: event.id,
      });
    }
  };

  /** True exactly once after a pointerup that should not become a slot click. */
  const consumeSuppressedClick = (): boolean => {
    const suppressed = suppressClickRef.current;
    suppressClickRef.current = false;
    return suppressed;
  };

  return {
    consumeSuppressedClick,
    /** Current offsets; pair with `subscribeDeltas` in useSyncExternalStore. */
    getDeltas,
    onPointerCancel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onTaskPointerDown,
    preview,
    subscribeDeltas,
  };
};
