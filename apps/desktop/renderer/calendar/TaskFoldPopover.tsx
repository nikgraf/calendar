import {
  calendarTaskKey,
  dueDayLabel,
  isOverdue,
  type TaskFold,
  taskFoldTitle,
  type TaskRecord,
} from '@calendar/core';
import { useRef } from 'react';
import { Popover } from '../ui/Popover.tsx';
import { TaskCheck } from './TaskCheck.tsx';
import type { useEventDrag } from './useEventDrag.ts';

/** The popover's width (`w-72`), so an anchor near the window's right edge can keep it inside. */
export const FOLD_POPOVER_WIDTH = 288;

/** Drag keys of the popover's rows, apart from the chips' and the rail's. */
const rowKey = (task: TaskRecord): string => `fold:${calendarTaskKey(task)}`;

/**
 * The list behind a fold chip in the all-day lane: today's overdue or
 * undated tasks, each with its checkbox. The rows are the ones the chip
 * held when it opened, drawn as they are now: a task ticked here stays,
 * struck through, so the rows never shift under the pointer and a slip
 * can be undone. A row drags onto the grid or the lane like the rail's
 * (the popover steps aside while it does); a click opens the task in the
 * side panel. Either closes the popover.
 */
export function TaskFoldPopover({
  anchor,
  drag,
  fold,
  isTaskReadOnly,
  listColorOf,
  onClose,
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
  onClose: () => void;
  onTaskClick: (task: TaskRecord) => void;
  onToggleTask: (task: TaskRecord) => void;
  tasks: ReadonlyArray<TaskRecord>;
  today: string;
}) {
  const title = taskFoldTitle(fold);
  // The row a press began on: only its release closes the list — a
  // checkbox's (which keeps its press to itself) leaves it open.
  const pressedRef = useRef<string | null>(null);
  // Hidden, not unmounted: the dragged row holds the pointer capture.
  const dragging = drag.preview?.itemKey.startsWith('fold:') === true;
  return (
    <Popover
      anchor={anchor}
      className={`w-72 ${dragging ? 'pointer-events-none opacity-0' : ''}`}
      closeLabel={`Close the ${title.toLowerCase()} list`}
      label={title}
      onClose={onClose}
    >
      <div data-testid={`all-day-fold-list-${fold}`}>
        <h3 className="px-1 pb-1 text-[11px] font-semibold tracking-wide text-ink-secondary uppercase">
          {title}
        </h3>
        <ul className="max-h-[min(60vh,26rem)] overflow-y-auto">
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
                  onPointerCancel={(event) => {
                    pressedRef.current = null;
                    drag.onPointerCancel(event);
                  }}
                  onPointerDown={(event) => {
                    pressedRef.current = event.button === 0 ? rowKey(task) : null;
                    drag.onTaskPointerDown(
                      task,
                      rowKey(task),
                      { dayIndex: 0, from: 'panel', readOnly },
                      event,
                    );
                  }}
                  onPointerMove={drag.onPointerMove}
                  onPointerUp={(event) => {
                    const pressed = pressedRef.current === rowKey(task);
                    pressedRef.current = null;
                    drag.onPointerUp(event);
                    // A release in place opened the task (the drag hook's
                    // click), a drag dropped it: either leaves the list.
                    if (pressed) {
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
