import {
  calendarTaskKey,
  dueDayLabel,
  isOverdue,
  type TaskFold,
  taskFoldTitle,
  type TaskRecord,
} from '@calendar/core';
import { useEffect, useRef } from 'react';
import { Popover } from '../ui/Popover.tsx';
import { TaskCheck } from './TaskCheck.tsx';
import type { useEventDrag } from './useEventDrag.ts';

/** The popover's width (`w-72`), so an anchor near the window's right edge can keep it inside. */
export const FOLD_POPOVER_WIDTH = 288;

/** Drag keys of the popover's rows, apart from the chips' and the rail's. */
const rowKey = (task: TaskRecord): string => `fold:${calendarTaskKey(task)}`;

/** The drag hook's own threshold: below it a release is a click. */
const DRAG_THRESHOLD_PX = 4;
/** The panel's padding around the list (`p-2`): a press still inside it has not left. */
const PANEL_INSET_PX = 8;
/** The panel around the rows: its padding, border and heading, plus a margin to the window's edge. */
const PANEL_CHROME_PX = 56;
/** The rows' tallest (`26rem`) and shortest heights; past the shortest the rows scroll. */
const LIST_MAX_PX = 416;
const LIST_MIN_PX = 96;

/** A press on a row: where it began, and whether it has left the list since. */
interface Press {
  left: boolean;
  readonly row: string;
  readonly x: number;
  readonly y: number;
}

/**
 * The list behind a fold chip in the all-day lane: today's overdue or
 * undated tasks, each with its checkbox. The rows are the ones the chip
 * held when it opened, drawn as they are now: a task ticked here stays,
 * struck through, so the rows never shift under the pointer and a slip
 * can be undone. A row pulled out of the list drags onto the grid or the
 * lane like the rail's (the list steps aside while it does); a press that
 * moves but stays inside the list drops nothing, since the calendar under
 * it is hidden. A click opens the task in the side panel. Either closes
 * the list; Escape mid-drag only ends the drag. Focus starts on the first
 * row.
 */
export function TaskFoldPopover({
  anchor,
  drag,
  fold,
  isTaskReadOnly,
  listColorOf,
  onClose,
  onDismiss,
  onTaskClick,
  onToggleTask,
  tasks,
  today,
}: {
  anchor: { readonly x: number; readonly y: number } | null;
  drag: ReturnType<typeof useEventDrag>;
  fold: TaskFold;
  isTaskReadOnly: (task: TaskRecord) => boolean;
  listColorOf: (task: TaskRecord) => string | undefined;
  /** A row was opened or dropped: the list is done. */
  onClose: () => void;
  /** Escape or a click beside the list: closed with nothing done. */
  onDismiss: () => void;
  onTaskClick: (task: TaskRecord) => void;
  onToggleTask: (task: TaskRecord) => void;
  tasks: ReadonlyArray<TaskRecord>;
  today: string;
}) {
  const title = taskFoldTitle(fold);
  // The rows fit the room below the chip, so a short window still shows
  // the list's end (they scroll inside it).
  const listMaxHeight = Math.max(
    Math.min(
      LIST_MAX_PX,
      window.innerHeight * 0.6,
      window.innerHeight - (anchor?.y ?? 0) - PANEL_CHROME_PX,
    ),
    LIST_MIN_PX,
  );
  const listRef = useRef<HTMLDivElement>(null);
  // The row a press began on: only its release closes the list — a
  // checkbox's (which keeps its press to itself) leaves it open.
  const pressRef = useRef<Press | null>(null);
  // Hidden, not unmounted: the dragged row holds the pointer capture.
  const dragging = drag.preview?.itemKey.startsWith('fold:') === true;
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-row-title]')?.focus();
  }, []);
  const inList = (event: React.PointerEvent) => {
    const box = listRef.current?.getBoundingClientRect();
    return (
      box !== undefined &&
      event.clientX >= box.left - PANEL_INSET_PX &&
      event.clientX <= box.right + PANEL_INSET_PX &&
      event.clientY >= box.top - PANEL_INSET_PX &&
      event.clientY <= box.bottom + PANEL_INSET_PX
    );
  };
  return (
    <Popover
      anchor={anchor}
      className={`w-72 ${dragging ? 'pointer-events-none opacity-0' : ''}`}
      closeLabel={`Close the ${title.toLowerCase()} list`}
      label={title}
      onClose={() => {
        // The list's Escape runs ahead of the drag hook's: mid-drag it
        // ends the drag and the list comes back.
        if (pressRef.current !== null && dragging) {
          pressRef.current = null;
          drag.abandon();
          return;
        }
        onDismiss();
      }}
    >
      {/* Tab stays in the list, as in a dialog: behind it the calendar is covered. */}
      <div
        data-testid={`all-day-fold-list-${fold}`}
        onKeyDown={(key) => {
          if (key.key !== 'Tab') {
            return;
          }
          const stops = [
            ...(listRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []),
          ];
          const at = stops.indexOf(document.activeElement as HTMLElement);
          const next = key.shiftKey
            ? at <= 0
              ? stops.at(-1)
              : stops[at - 1]
            : at === stops.length - 1
              ? stops[0]
              : stops[at + 1];
          if (next) {
            key.preventDefault();
            next.focus();
          }
        }}
        ref={listRef}
      >
        <h3 className="px-1 pb-1 text-[11px] font-semibold tracking-wide text-ink-secondary uppercase">
          {title}
        </h3>
        <ul className="overflow-y-auto" style={{ maxHeight: listMaxHeight }}>
          {tasks.map((task) => {
            const done = task.status === 'completed';
            const readOnly = isTaskReadOnly(task);
            const late = isOverdue(task, today);
            return (
              <li key={calendarTaskKey(task)}>
                <div
                  className={`flex touch-none items-center gap-1 rounded-control py-0.5 pr-1 select-none hover:bg-fill ${
                    readOnly ? '' : 'cursor-grab'
                  }`}
                  data-testid={`fold-task-${task.id}`}
                  onLostPointerCapture={() => {
                    // A capture lost without a release (the drag hook
                    // abandons the press then): no later release on this
                    // row, a checkbox's included, may act on it.
                    pressRef.current = null;
                  }}
                  onPointerCancel={(event) => {
                    pressRef.current = null;
                    drag.onPointerCancel(event);
                  }}
                  onPointerDown={(event) => {
                    pressRef.current =
                      event.button === 0
                        ? { left: false, row: rowKey(task), x: event.clientX, y: event.clientY }
                        : null;
                    drag.onTaskPointerDown(
                      task,
                      rowKey(task),
                      { dayIndex: 0, from: 'panel', readOnly },
                      event,
                    );
                  }}
                  onPointerMove={(event) => {
                    // The drag starts once the row is pulled out of the list.
                    const press = pressRef.current;
                    if (press !== null && !press.left) {
                      if (inList(event)) {
                        return;
                      }
                      press.left = true;
                    }
                    drag.onPointerMove(event);
                  }}
                  onPointerUp={(event) => {
                    const press = pressRef.current;
                    pressRef.current = null;
                    if (press?.row !== rowKey(task)) {
                      drag.onPointerUp(event);
                      return;
                    }
                    const moved =
                      Math.hypot(event.clientX - press.x, event.clientY - press.y) >=
                      DRAG_THRESHOLD_PX;
                    // Released out of the list without a move out there (a
                    // flick): the drag starts at the release.
                    if (moved && !press.left && !inList(event)) {
                      press.left = true;
                      drag.onPointerMove(event);
                    }
                    if (moved && !press.left) {
                      // Moved, but never out of the list: neither a click
                      // nor a drop, and the list stays.
                      drag.onPointerCancel(event);
                      return;
                    }
                    // Read before the release clears it: whether it lands.
                    const drops = moved && drag.getDeltas().target !== null;
                    drag.onPointerUp(event);
                    // A release in place opened the task (the drag hook's
                    // click), a drop moved it: either leaves the list. A
                    // drag that lands nowhere (a read-only row, a release
                    // over the sidebar) changed nothing, and the list stays.
                    if (!moved || drops) {
                      onClose();
                    }
                  }}
                >
                  <TaskCheck
                    aria-label={`${done ? 'Reopen' : 'Mark done'}: ${task.title}`}
                    checked={done}
                    disabled={readOnly}
                    listColor={listColorOf(task)}
                    onClick={() => onToggleTask(task)}
                    onPointerDown={(event) => event.stopPropagation()}
                    overdue={late}
                    size="row"
                  />
                  {/* The press-and-release opens the task through the drag hook; the button keeps the keyboard. */}
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm outline-none focus-visible:underline"
                    data-row-title
                    onKeyDown={(key) => {
                      if (key.key === 'Enter' || key.key === ' ') {
                        key.preventDefault();
                        onTaskClick(task);
                        onClose();
                      }
                    }}
                    type="button"
                  >
                    <span
                      className={`min-w-0 flex-1 truncate ${done ? 'text-ink-secondary line-through' : ''}`}
                    >
                      {task.title}
                    </span>
                    {/* The heading already says "Overdue". */}
                    {late && task.dueDate !== undefined ? (
                      <span className="shrink-0 text-[11px] text-danger">
                        {dueDayLabel(task.dueDate, today)}
                      </span>
                    ) : null}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </Popover>
  );
}
