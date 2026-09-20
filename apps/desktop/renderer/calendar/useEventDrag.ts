import { commitTaskDrop, useGuardedMutations } from '@calendar/app-state';
import {
  type DropTarget,
  dropTargetAt,
  moveEventTimes,
  moveTimedTask,
  resizeEventEnd,
  snapMinutes,
  type EventRecord,
  type TaskRecord,
  type Temporal,
} from '@calendar/core';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';

const DRAG_THRESHOLD_PX = 4;

export type DragMode = 'move' | 'resize';
/** Where a task drag started: its timed block in the grid, or its chip in the all-day lane. */
export type TaskDragOrigin = 'grid' | 'lane';

/** Which block is being dragged, and how. Changes twice per drag. */
export interface DragPreview {
  /** Set for task drags: which lane the chip came from. */
  readonly from?: TaskDragOrigin;
  readonly itemKey: string;
  readonly mode: DragMode;
}

/** The live offsets of that drag. Published per pointermove, outside React state. */
export interface DragDeltas {
  readonly deltaDays: number;
  readonly deltaMinutes: number;
  /** Where a dragged task chip would land now; null outside the lane and grid. Events ignore it. */
  readonly target: DropTarget | null;
}

/** Listener key for the drop indicators: notified on every pointermove of a task drag. */
const DROP_TARGET_KEY = 'drop-target';

const NO_DELTAS: DragDeltas = { deltaDays: 0, deltaMinutes: 0, target: null };

const sameTarget = (a: DropTarget | null, b: DropTarget | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.kind === b.kind &&
    a.dayIndex === b.dayIndex &&
    (a.kind !== 'timed' || b.kind !== 'timed' || a.minute === b.minute));

interface DragOrigin {
  active: boolean;
  readonly itemKey: string;
  readonly mode: DragMode;
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly target:
    | { readonly event: EventRecord; readonly kind: 'event' }
    | {
        /** The strip column the chip or block started in. */
        readonly dayIndex: number;
        readonly from: TaskDragOrigin;
        readonly kind: 'task';
        readonly readOnly: boolean;
        readonly task: TaskRecord;
      };
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
 * Task chips also drag between the all-day lane and the grid: their drop is
 * judged by where the pointer is released (`DragDeltas.target`), so a lane
 * chip can take a time and a timed block can lose one.
 *
 * Only `preview` (which block, which mode) is React state; the per-move
 * offsets go through a tiny external store so the dragged block alone
 * re-renders per pointermove — the grid used to re-lay out every column on
 * each one.
 */
export const useEventDrag = ({
  gridRef,
  hourHeight,
  laneRef,
  onEventClick,
  onTaskClick,
  scrollerRef,
  strip,
}: {
  /** The timed strip: its rect gives the column width and where minute 0 sits. */
  gridRef: RefObject<HTMLDivElement | null>;
  hourHeight: number;
  /** The all-day lane; a release inside it drops as all-day. */
  laneRef: RefObject<HTMLDivElement | null>;
  onEventClick: (event: EventRecord) => void;
  onTaskClick: (task: TaskRecord) => void;
  /** The grid's vertical scroller: the visible extent a release counts inside. */
  scrollerRef: RefObject<HTMLDivElement | null>;
  /** The rendered day columns, buffer included. */
  strip: ReadonlyArray<Temporal.PlainDate>;
}) => {
  const { updateEvent, updateRecurring, updateTask } = useGuardedMutations();
  const [preview, setPreview] = useState<DragPreview | null>(null);
  const originRef = useRef<DragOrigin | null>(null);
  const deltasRef = useRef<DragDeltas>(NO_DELTAS);
  const activeItemKeyRef = useRef<string | null>(null);
  const listenersRef = useRef(new Map<string, Set<() => void>>());
  const publishDeltas = (next: DragDeltas) => {
    const current = deltasRef.current;
    if (
      current.deltaDays === next.deltaDays &&
      current.deltaMinutes === next.deltaMinutes &&
      sameTarget(current.target, next.target)
    ) {
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
    for (const listener of listenersRef.current.get(DROP_TARGET_KEY) ?? []) {
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
    // A suppressed click belongs to the gesture that set it. A cancelled
    // pointer usually never delivers its click, so a new press clears the
    // flag instead of letting it swallow the user's next, unrelated click.
    const onPressStart = () => {
      suppressClickRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPressStart, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPressStart, true);
    };
  }, []);

  /** The lane or grid slot under the pointer, in viewport coordinates. */
  const targetAt = (clientX: number, clientY: number): DropTarget | null => {
    const grid = gridRef.current?.getBoundingClientRect();
    const lane = laneRef.current?.getBoundingClientRect();
    const scroller = scrollerRef.current?.getBoundingClientRect();
    if (!grid || !lane || !scroller) {
      return null;
    }
    return dropTargetAt(clientX, clientY, {
      columnWidth: grid.width / strip.length,
      dayCount: strip.length,
      grid: { bottom: scroller.bottom, top: scroller.top },
      // The strip scrolls with its content, so its top is minute 0.
      gridContentTop: grid.top,
      hourHeight,
      lane: { bottom: lane.bottom, top: lane.top },
      stripLeft: grid.left,
    });
  };

  const deltasFor = (origin: DragOrigin, clientX: number, clientY: number): DragDeltas => {
    const deltaMinutes = snapMinutes(((clientY - origin.startClientY) / hourHeight) * 60);
    if (origin.mode === 'resize') {
      return { deltaDays: 0, deltaMinutes, target: null };
    }
    const grid = gridRef.current?.getBoundingClientRect();
    const dayWidth = grid ? grid.width / strip.length : 0;
    const deltaDays = dayWidth > 0 ? Math.round((clientX - origin.startClientX) / dayWidth) : 0;
    const pointed = origin.target.kind === 'task' ? targetAt(clientX, clientY) : null;
    // A block dragged from the grid moves by whole columns from where it
    // was pressed (it is drawn that way), so its drop day follows the same
    // delta rather than the column under the pointer — the two differ when
    // the press was off-centre. A lane chip instead follows the pointer's
    // column, and its preview shifts to match (AllDayTaskChip).
    const target =
      pointed !== null && origin.target.kind === 'task' && origin.target.from === 'grid'
        ? {
            ...pointed,
            dayIndex: Math.min(Math.max(origin.target.dayIndex + deltaDays, 0), strip.length - 1),
          }
        : pointed;
    return { deltaDays, deltaMinutes, target };
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
    options: {
      readonly dayIndex: number;
      readonly from: TaskDragOrigin;
      readonly readOnly: boolean;
    },
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
      target: {
        dayIndex: options.dayIndex,
        from: options.from,
        kind: 'task',
        readOnly: options.readOnly,
        task,
      },
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
      setPreview({
        ...(origin.target.kind === 'task' ? { from: origin.target.from } : {}),
        itemKey: origin.itemKey,
        mode: origin.mode,
      });
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

    const { deltaDays, deltaMinutes, target } = deltasFor(
      origin,
      domEvent.clientX,
      domEvent.clientY,
    );
    if (origin.target.kind === 'task') {
      const { from, task } = origin.target;
      const commit = (changes: Parameters<typeof updateTask>[0]['changes']) =>
        void updateTask({
          accountId: task.accountId,
          changes,
          taskId: task.id,
          taskListId: task.listId,
        });
      // A chip from the lane, or a block released over the lane, drops by
      // where the pointer is; a block moved within the grid keeps its
      // delta-based move, which starts from where the block is drawn.
      if (from === 'lane' || target?.kind === 'allDay') {
        const day = target === null ? undefined : strip[target.dayIndex];
        if (target !== null && day !== undefined) {
          commitTaskDrop(task, day.toString(), target, updateTask);
        }
        return;
      }
      if (deltaMinutes === 0 && deltaDays === 0) {
        return;
      }
      const changes = moveTimedTask(task, deltaMinutes, deltaDays);
      if (changes) {
        commit(changes);
      }
      return;
    }
    if (deltaMinutes === 0 && deltaDays === 0) {
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

  const subscribeDropTarget = useCallback(
    (listener: () => void) => subscribeDeltas(DROP_TARGET_KEY, listener),
    [subscribeDeltas],
  );

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
    /** Pair with `getDeltas` in useSyncExternalStore to follow a task drag's drop target. */
    subscribeDropTarget,
  };
};

/**
 * The live drop target of a task drag, for the lane and grid indicators:
 * null while nothing is dragged or the pointer is outside both.
 */
export const useDropTarget = (
  drag: ReturnType<typeof useEventDrag>,
): { readonly from: TaskDragOrigin; readonly target: DropTarget } | null => {
  const deltas = useSyncExternalStore(drag.subscribeDropTarget, drag.getDeltas);
  const from = drag.preview?.from;
  return from === undefined || deltas.target === null ? null : { from, target: deltas.target };
};
