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
/**
 * Where a task drag started: its timed block in the grid, its chip in the
 * all-day lane, or its row in the side panel's inbox (which has no place
 * on the grid: a ghost follows the pointer instead).
 */
export type TaskDragOrigin = 'grid' | 'lane' | 'panel';

/** Which block is being dragged, and how. Changes twice per drag. */
export interface DragPreview {
  /** Set for task drags: which lane the chip came from. */
  readonly from?: TaskDragOrigin;
  readonly itemKey: string;
  /** Set for task drags: what the ghost of a panel drag shows. */
  readonly label?: string;
  readonly mode: DragMode;
}

/** The pointer, in viewport coordinates, while a panel row is dragged. */
export interface DragPointer {
  readonly x: number;
  readonly y: number;
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
/** Listener key for the panel drag's ghost: notified on every pointermove of one. */
const GHOST_KEY = 'ghost';

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
    | { readonly event: EventRecord; readonly kind: 'event'; readonly readOnly: boolean }
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
// override, like Fantastical. All-day chips stay fixed, and nothing in a
// calendar or list we cannot write moves.
const isDraggable = (origin: DragOrigin): boolean =>
  !origin.target.readOnly &&
  (origin.target.kind === 'task' ||
    (!origin.target.event.isAllDay && !origin.target.event.recurrence));

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
  isEventReadOnly,
  laneRef,
  onEventClick,
  onTaskClick,
  scrollerRef,
  strip,
}: {
  /** The timed strip: its rect gives the column width and where minute 0 sits. */
  gridRef: RefObject<HTMLDivElement | null>;
  hourHeight: number;
  /** An event in a calendar we cannot write opens on click but never drags. */
  isEventReadOnly: (event: EventRecord) => boolean;
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
  const pointerRef = useRef<DragPointer | null>(null);
  const publishPointer = (next: DragPointer | null) => {
    if (next === pointerRef.current) {
      return;
    }
    pointerRef.current = next;
    for (const listener of listenersRef.current.get(GHOST_KEY) ?? []) {
      listener();
    }
  };
  const getPointer = useCallback(() => pointerRef.current, []);
  // Suppresses the day column's slot-click that follows a drag's pointerup.
  const suppressClickRef = useRef(false);

  /** Ends a press without changing anything: Escape, a cancelled pointer, a lost capture. */
  const abandonPress = () => {
    // The abandoned release still emits a click — keep it from falling
    // through to the day column's slot-click.
    if (originRef.current?.active) {
      suppressClickRef.current = true;
    }
    originRef.current = null;
    setPreview(null);
    publishDeltas(NO_DELTAS);
    publishPointer(null);
    activeItemKeyRef.current = null;
  };

  useEffect(() => {
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape' && originRef.current) {
        abandonPress();
      }
    };
    // Enter and Space open the focused block, chip or row, and a press
    // focuses what it lands on: hit mid-drag, they would open its editor,
    // whose panel narrows the grid under the pointer and so moves the drop.
    // Captured here, ahead of the item's own key handler.
    const onActivationKey = (keyEvent: KeyboardEvent) => {
      if (originRef.current && (keyEvent.key === 'Enter' || keyEvent.key === ' ')) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
      }
    };
    // A capture lost without a pointerup (the button went up where the item
    // never heard it: a second mouse or trackpad moving mid-drag does that)
    // would leave the press lifted, holding its drop indicator and the wheel
    // pan, until the next one. A release ends the press before its capture
    // goes, so only an abandoned press gets here.
    const onLostCapture = (pointerEvent: PointerEvent) => {
      if (originRef.current?.pointerId === pointerEvent.pointerId) {
        abandonPress();
      }
    };
    // A suppressed click belongs to the gesture that set it. A cancelled
    // pointer usually never delivers its click, so a new press clears the
    // flag instead of letting it swallow the user's next, unrelated click.
    const onPressStart = () => {
      suppressClickRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keydown', onActivationKey, true);
    window.addEventListener('lostpointercapture', onLostCapture, true);
    window.addEventListener('pointerdown', onPressStart, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keydown', onActivationKey, true);
      window.removeEventListener('lostpointercapture', onLostCapture, true);
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

  /**
   * `dropTargetAt` clamps the pointer into the nearest column, which a chip
   * dragged along the lane past its edge wants. A panel row has no column
   * of its own: released over the panel or the sidebar it must stay put,
   * so its pointer has to be over the calendar (the scroller's width, the
   * lane above included) to count.
   */
  const insideCalendar = (origin: DragOrigin, clientX: number): boolean => {
    if (origin.target.kind !== 'task' || origin.target.from !== 'panel') {
      return true;
    }
    const scroller = scrollerRef.current?.getBoundingClientRect();
    return scroller !== undefined && clientX >= scroller.left && clientX <= scroller.right;
  };

  const deltasFor = (origin: DragOrigin, clientX: number, clientY: number): DragDeltas => {
    const deltaMinutes = snapMinutes(((clientY - origin.startClientY) / hourHeight) * 60);
    if (origin.mode === 'resize') {
      return { deltaDays: 0, deltaMinutes, target: null };
    }
    const grid = gridRef.current?.getBoundingClientRect();
    const dayWidth = grid ? grid.width / strip.length : 0;
    const deltaDays = dayWidth > 0 ? Math.round((clientX - origin.startClientX) / dayWidth) : 0;
    const pointed =
      origin.target.kind === 'task' && insideCalendar(origin, clientX)
        ? targetAt(clientX, clientY)
        : null;
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
      target: { event, kind: 'event', readOnly: isEventReadOnly(event) },
    };
    if (!isDraggable(origin) && mode !== 'move') {
      return;
    }
    // Capture presses on blocks that cannot move too (read-only, recurring
    // masters): the release must come back here — a click opens the event,
    // a drag does nothing — instead of landing on the grid as a slot click.
    domEvent.currentTarget.setPointerCapture(domEvent.pointerId);
    originRef.current = origin;
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
        ...(origin.target.kind === 'task'
          ? { from: origin.target.from, label: origin.target.task.title }
          : {}),
        itemKey: origin.itemKey,
        mode: origin.mode,
      });
    }
    publishDeltas(deltasFor(origin, domEvent.clientX, domEvent.clientY));
    if (origin.target.kind === 'task' && origin.target.from === 'panel') {
      publishPointer({ x: domEvent.clientX, y: domEvent.clientY });
    }
  };

  const onPointerCancel = (domEvent: React.PointerEvent) => {
    const origin = originRef.current;
    if (!origin || origin.pointerId !== domEvent.pointerId) {
      return;
    }
    abandonPress();
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
    publishPointer(null);
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
      // A chip from the lane or a row from the panel, or a block released
      // over the lane, drops by where the pointer is; a block moved within
      // the grid keeps its delta-based move, which starts from where the
      // block is drawn. A panel row let go elsewhere (the month view, the
      // panel itself) changes nothing.
      if (from === 'lane' || from === 'panel' || target?.kind === 'allDay') {
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
  const subscribeGhost = useCallback(
    (listener: () => void) => subscribeDeltas(GHOST_KEY, listener),
    [subscribeDeltas],
  );

  return {
    consumeSuppressedClick,
    /** Current offsets; pair with `subscribeDeltas` in useSyncExternalStore. */
    getDeltas,
    /** The pointer of a panel drag; pair with `subscribeGhost`. */
    getPointer,
    onPointerCancel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onTaskPointerDown,
    preview,
    subscribeDeltas,
    /** Pair with `getDeltas` in useSyncExternalStore to follow a task drag's drop target. */
    subscribeDropTarget,
    subscribeGhost,
  };
};

/** Where a panel row's ghost sits: null unless a panel drag is under way. */
export const useDragPointer = (drag: ReturnType<typeof useEventDrag>): DragPointer | null =>
  useSyncExternalStore(drag.subscribeGhost, drag.getPointer);

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
