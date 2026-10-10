import {
  useGuardedMutations,
  useListColorLookup,
  useTaskInbox,
  useTaskReadOnlyLookup,
  useToday,
} from '@calendar/app-state';
import { calendarTaskKey, overdueLabel, type TaskRecord } from '@calendar/core';
import { TaskCheck } from '../TaskCheck.tsx';
import type { useEventDrag } from '../useEventDrag.ts';

/**
 * The rail's task inbox: the late ones, today's and the undated ones. A
 * row's checkbox completes it; the row itself opens the task editor. New
 * tasks come from "+ New" (its Task kind, with "No due date" for an
 * inbox add). Rows carry no `title` attribute: the grid's `[title^=…]`
 * selectors must keep matching the grid alone.
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
  const { completeTask } = useGuardedMutations();
  const listColorOf = useListColorLookup();
  const isReadOnly = useTaskReadOnlyLookup();

  const toggle = (task: TaskRecord) =>
    void completeTask({
      accountId: task.accountId,
      status: task.status === 'completed' ? 'needsAction' : 'completed',
      taskId: task.id,
      taskListId: task.listId,
    });

  const row = (task: TaskRecord, late: boolean) => {
    const done = task.status === 'completed';
    const readOnly = isReadOnly(task);
    const dragging = drag.preview?.itemKey === `panel:${calendarTaskKey(task)}`;
    return (
      <li
        className={`flex touch-none items-center gap-1 rounded-control py-0.5 pr-2 pl-0.5 select-none hover:bg-fill ${
          readOnly ? '' : 'cursor-grab'
        } ${dragging ? 'opacity-50' : ''}`}
        data-testid={`panel-task-${task.id}`}
        key={`${task.listId}:${task.id}`}
        onPointerCancel={drag.onPointerCancel}
        onPointerDown={(event) =>
          drag.onTaskPointerDown(
            task,
            `panel:${calendarTaskKey(task)}`,
            { dayIndex: 0, from: 'panel', readOnly },
            event,
          )
        }
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
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
          onKeyDown={(key) => {
            if (key.key === 'Enter' || key.key === ' ') {
              key.preventDefault();
              onEdit(task);
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
      </li>
    );
  };

  const section = (label: string, tasks: ReadonlyArray<TaskRecord>, late = false) =>
    tasks.length === 0 ? null : (
      <section className="mb-2" key={label}>
        <h3 className="px-2 pb-0.5 text-[11px] font-semibold tracking-wide text-ink-secondary uppercase">
          {label}
        </h3>
        <ul>{tasks.map((task) => row(task, late))}</ul>
      </section>
    );

  const empty = inbox.overdue.length + inbox.today.length + inbox.noDate.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pt-3" data-testid="task-inbox">
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
      </div>
    </div>
  );
}
