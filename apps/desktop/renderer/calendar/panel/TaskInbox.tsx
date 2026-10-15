import {
  useGuardedMutations,
  useListColorLookup,
  useTaskInbox,
  useTaskReadOnlyLookup,
  useToday,
} from '@calendar/app-state';
import {
  calendarTaskKey,
  canPlaceTask,
  flattenTaskTree,
  indentTaskDrop,
  nestSubtasks,
  outdentTaskDrop,
  overdueLabel,
  type TaskInboxRow,
  type TaskPlacement,
  type TaskPlacementDrop,
  type TaskRecord,
  taskDropAt,
} from '@calendar/core';
import { useEffect, useRef, useState } from 'react';
import { TaskCheck } from '../TaskCheck.tsx';
import type { useEventDrag } from '../useEventDrag.ts';

/** A subtask's indent (the nested list's `pl-7`), and how far sideways a drag nests or un-nests. */
const INDENT_PX = 28;
/** The drag hook's own threshold: below it a release is a click. */
const DRAG_THRESHOLD_PX = 4;
/** How long the focus follows a row ⌘] or ⌘[ placed through the redraws its write causes. */
const REFOCUS_MS = 2000;

/** A press on a row Google can place, with its section's rows as drawn then. */
interface Press {
  readonly row: TaskInboxRow;
  readonly rows: ReadonlyArray<TaskInboxRow>;
  readonly section: string;
  readonly x: number;
  readonly y: number;
}

/** Where the line between two rows is drawn, in the scroller's content coordinates. */
interface DropLine {
  readonly depth: 0 | 1;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

/**
 * What releasing the pressed row at (x, y) does inside its section: the
 * gap is the one the pointer is in (row midpoints), the depth its own
 * moved by a sideways drag of half an indent. Null outside the section
 * or the rail, or where `taskDropAt` changes nothing.
 */
const railDropAt = (
  scroller: HTMLElement,
  press: Press,
  x: number,
  y: number,
): { readonly drop: TaskPlacementDrop; readonly line: DropLine } | null => {
  const box = scroller.getBoundingClientRect();
  const section = scroller.querySelector(`[data-section="${press.section}"]`);
  const list = section?.querySelector('ul')?.getBoundingClientRect();
  if (!list || x < box.left || x > box.right || y < list.top - 8 || y > list.bottom + 8) {
    return null;
  }
  const rectOf = (row: TaskInboxRow) =>
    scroller
      .querySelector(`[data-task-key="${CSS.escape(calendarTaskKey(row.task))}"]`)
      ?.getBoundingClientRect();
  const pressed = calendarTaskKey(press.row.task);
  const others = press.rows.filter((row) => calendarTaskKey(row.task) !== pressed);
  const slot = others.filter((row) => {
    const rect = rectOf(row);
    return rect !== undefined && rect.top + rect.height / 2 < y;
  }).length;
  const shift = x - press.x;
  const depth = Math.min(
    Math.max(press.row.depth + (shift >= INDENT_PX / 2 ? 1 : shift <= -INDENT_PX / 2 ? -1 : 0), 0),
    1,
  ) as 0 | 1;
  const drop = taskDropAt(press.rows, press.row.task, slot, depth);
  const above = drop === null ? undefined : others[drop.slot - 1];
  const below = drop === null ? undefined : others[drop.slot];
  const edge = above ? rectOf(above)?.bottom : below ? rectOf(below)?.top : undefined;
  if (drop === null || edge === undefined) {
    return null;
  }
  const inset = drop.depth * INDENT_PX;
  return {
    drop,
    line: {
      depth: drop.depth,
      left: list.left - box.left + inset,
      top: edge - box.top + scroller.scrollTop,
      width: list.width - inset,
    },
  };
};

/**
 * The rail's task inbox: the late ones, today's and the undated ones. A
 * row's checkbox completes it; the row itself opens the task editor. New
 * tasks come from "+ New" (its Task kind, with "No due date" for an
 * inbox add). A Google subtask sits in a nested list under its parent
 * when both are in one group (`nestSubtasks`). Rows carry no `title`
 * attribute: the grid's `[title^=…]` selectors must keep matching the
 * grid alone.
 *
 * A Google row dragged within its section reorders it among subtasks or
 * nests it (`taskDropAt`): a line shows the gap, indented when it lands as
 * a subtask; dragging half an indent right nests it, left takes a subtask
 * out of its parent. Top-level rows keep the section's order (day, then
 * title), and a row dragged out of the rail drops onto the grid or lane
 * as before. On a focused row ⌘] indents and ⌘[ outdents, as in
 * Reminders.
 */
export function TaskInbox({
  drag,
  onEdit,
  timeZone,
}: {
  /** The app's drag hook: a row drags onto the grid or lane like a chip; a release in place opens it. */
  drag: ReturnType<typeof useEventDrag>;
  onEdit: (task: TaskRecord) => void;
  timeZone: string;
}) {
  const inbox = useTaskInbox(timeZone);
  const today = useToday(timeZone);
  const { completeTask, reorderTask } = useGuardedMutations();
  const listColorOf = useListColorLookup();
  const isReadOnly = useTaskReadOnlyLookup();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<Press | null>(null);
  /**
   * The row ⌘] or ⌘[ just placed: drawn anew in its new list (and again
   * as the push settles it), its button keeps the focus for a moment.
   */
  const refocusRef = useRef<{ readonly key: string; readonly until: number } | null>(null);
  const [line, setLine] = useState<DropLine | null>(null);
  const { getPointer, subscribeGhost } = drag;

  // The drag hook publishes the pointer of a row drag (the ghost's), and
  // null once it ends or is abandoned.
  useEffect(
    () =>
      subscribeGhost(() => {
        const pointer = getPointer();
        const press = pressRef.current;
        const scroller = scrollerRef.current;
        setLine(
          pointer && press && scroller
            ? (railDropAt(scroller, press, pointer.x, pointer.y)?.line ?? null)
            : null,
        );
      }),
    [getPointer, subscribeGhost],
  );

  useEffect(() => {
    const refocus = refocusRef.current;
    if (refocus === null || Date.now() > refocus.until) {
      refocusRef.current = null;
      return;
    }
    const button = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-task-key="${CSS.escape(refocus.key)}"] [data-row-title]`,
    );
    if (button && document.activeElement !== button) {
      button.focus();
    }
  }, [inbox]);
  // A press anywhere is the user moving on.
  useEffect(() => {
    const release = () => {
      refocusRef.current = null;
    };
    window.addEventListener('pointerdown', release, true);
    return () => window.removeEventListener('pointerdown', release, true);
  }, []);

  const place = (task: TaskRecord, placement: TaskPlacement) =>
    void reorderTask({
      accountId: task.accountId,
      taskId: task.id,
      taskListId: task.listId,
      ...placement,
    });

  const toggle = (task: TaskRecord) =>
    void completeTask({
      accountId: task.accountId,
      status: task.status === 'completed' ? 'needsAction' : 'completed',
      taskId: task.id,
      taskListId: task.listId,
    });

  const release = (event: React.PointerEvent) => {
    const press = pressRef.current;
    pressRef.current = null;
    setLine(null);
    const scroller = scrollerRef.current;
    // A drag still under way (Escape or a lost capture abandon it and the
    // pointer goes) that moved past the click threshold.
    const placed =
      press !== null &&
      scroller !== null &&
      getPointer() !== null &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) >= DRAG_THRESHOLD_PX
        ? railDropAt(scroller, press, event.clientX, event.clientY)
        : null;
    drag.onPointerUp(event);
    if (press !== null && placed !== null) {
      place(press.row.task, placed.drop.placement);
    }
  };

  // The row is a div, not its <li>: a subtask's list sits inside its
  // parent's <li>, and a press there must not drag the parent too.
  const row = (
    entry: TaskInboxRow,
    rows: ReadonlyArray<TaskInboxRow>,
    section: string,
    late: boolean,
  ) => {
    const { task } = entry;
    const done = task.status === 'completed';
    const readOnly = isReadOnly(task);
    const dragging = drag.preview?.itemKey === `panel:${calendarTaskKey(task)}`;
    return (
      <div
        className={`flex touch-none items-center gap-1 rounded-control py-0.5 pr-2 pl-0.5 select-none hover:bg-fill ${
          readOnly ? '' : 'cursor-grab'
        } ${dragging ? 'opacity-50' : ''}`}
        data-task-key={calendarTaskKey(task)}
        data-testid={`panel-task-${task.id}`}
        onPointerCancel={(event) => {
          pressRef.current = null;
          setLine(null);
          drag.onPointerCancel(event);
        }}
        onPointerDown={(event) => {
          pressRef.current =
            event.button === 0 && !readOnly && canPlaceTask(task)
              ? { row: entry, rows, section, x: event.clientX, y: event.clientY }
              : null;
          drag.onTaskPointerDown(
            task,
            `panel:${calendarTaskKey(task)}`,
            { dayIndex: 0, from: 'panel', readOnly },
            event,
          );
        }}
        onPointerMove={drag.onPointerMove}
        onPointerUp={release}
      >
        <TaskCheck
          aria-label={`${done ? 'Reopen' : 'Mark done'}: ${task.title}`}
          checked={done}
          disabled={readOnly}
          listColor={listColorOf(task)}
          onClick={() => toggle(task)}
          onPointerDown={(event) => event.stopPropagation()}
          overdue={late}
          size="row"
        />
        {/* The press-and-release opens the editor through the drag hook; the button keeps the keyboard. */}
        <button
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm outline-none focus-visible:underline"
          data-row-title
          onKeyDown={(key) => {
            if (key.key === 'Enter' || key.key === ' ') {
              key.preventDefault();
              onEdit(task);
            }
            if (key.metaKey && (key.key === ']' || key.key === '[') && !readOnly) {
              const drop =
                key.key === ']' ? indentTaskDrop(rows, task) : outdentTaskDrop(rows, task);
              if (drop) {
                key.preventDefault();
                refocusRef.current = {
                  key: calendarTaskKey(task),
                  until: Date.now() + REFOCUS_MS,
                };
                place(task, drop.placement);
              }
            }
          }}
          type="button"
        >
          <span
            className={`min-w-0 flex-1 truncate ${done ? 'text-ink-secondary line-through' : ''}`}
          >
            {task.title}
          </span>
          {late ? (
            <span className="shrink-0 text-[11px] text-danger">{overdueLabel(task, today)}</span>
          ) : null}
        </button>
      </div>
    );
  };

  const section = (label: string, tasks: ReadonlyArray<TaskRecord>, late = false) => {
    if (tasks.length === 0) {
      return null;
    }
    const tree = nestSubtasks(tasks);
    const rows = flattenTaskTree(tree);
    return (
      <section className="mb-2" data-section={label} key={label}>
        <h3 className="px-2 pb-0.5 text-[11px] font-semibold tracking-wide text-ink-secondary uppercase">
          {label}
        </h3>
        <ul>
          {tree.map(({ subtasks, task }) => (
            <li key={calendarTaskKey(task)}>
              {row({ depth: 0, group: task, task }, rows, label, late)}
              {subtasks.length === 0 ? null : (
                // Indented by the hit square: a subtask's box lines up under its parent's title.
                <ul className="pl-7">
                  {subtasks.map((subtask) => (
                    <li key={calendarTaskKey(subtask)}>
                      {row({ depth: 1, group: task, task: subtask }, rows, label, late)}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>
    );
  };

  const empty = inbox.overdue.length + inbox.today.length + inbox.noDate.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="relative min-h-0 flex-1 overflow-y-auto px-1 pt-3"
        data-testid="task-inbox"
        ref={scrollerRef}
      >
        {section('Overdue', inbox.overdue, true)}
        {section('Today', inbox.today)}
        {section('No date', inbox.noDate)}
        {empty ? (
          <p className="px-2 py-4 text-center text-sm text-ink-secondary">No tasks for today.</p>
        ) : null}
        {inbox.completedToday.length > 0 ? (
          <p className="px-2 pt-1 text-[11px] text-ink-secondary">
            {inbox.completedToday.length} done today
          </p>
        ) : null}
        {line ? (
          <div
            className="pointer-events-none absolute z-10 h-0.5 -translate-y-px rounded-full bg-primary"
            data-depth={line.depth}
            data-testid="task-drop-line"
            style={{ left: line.left, top: line.top, width: line.width }}
          />
        ) : null}
      </div>
    </div>
  );
}
