import {
  useGuardedMutations,
  useListColorLookup,
  useTaskInbox,
  useTaskLists,
  useTaskReadOnlyLookup,
  useToday,
} from '@calendar/app-state';
import { overdueLabel, type TaskRecord } from '@calendar/core';
import { useState } from 'react';
import { CheckIcon, PlusIcon } from '../../ui/icons.tsx';

/**
 * The rail's task inbox: the late ones, today's and the undated ones,
 * then a field that adds an undated task to the first writable list. A
 * row's checkbox completes it; the row itself opens the task editor.
 * Rows carry no `title` attribute: the grid's `[title^=…]` selectors must
 * keep matching the grid alone.
 */
export function TaskInbox({
  onEdit,
  timeZone,
}: {
  onEdit: (task: TaskRecord) => void;
  timeZone: string;
}) {
  const inbox = useTaskInbox(timeZone);
  const today = useToday(timeZone);
  const { completeTask, createTask } = useGuardedMutations();
  const listColorOf = useListColorLookup();
  const isReadOnly = useTaskReadOnlyLookup();
  const taskLists = useTaskLists();
  const target = taskLists.find((list) => list.isVisible && !list.readOnly);
  const [title, setTitle] = useState('');

  const toggle = (task: TaskRecord) =>
    void completeTask({
      accountId: task.accountId,
      status: task.status === 'completed' ? 'needsAction' : 'completed',
      taskId: task.id,
      taskListId: task.listId,
    });

  const add = () => {
    const trimmed = title.trim();
    if (!target || !trimmed) {
      return;
    }
    void createTask({ accountId: target.accountId, taskListId: target.id, title: trimmed });
    setTitle('');
  };

  const row = (task: TaskRecord, late: boolean) => {
    const done = task.status === 'completed';
    const readOnly = isReadOnly(task);
    return (
      <li
        className="flex items-center gap-2 rounded-control px-2 py-1 hover:bg-fill"
        data-testid={`panel-task-${task.id}`}
        key={`${task.listId}:${task.id}`}
      >
        <button
          aria-label={`${done ? 'Reopen' : 'Mark done'}: ${task.title}`}
          className={`flex size-4 shrink-0 items-center justify-center rounded-full border-2 ${
            done ? 'border-primary bg-primary text-on-primary' : 'border-hairline-strong'
          } disabled:opacity-50`}
          disabled={readOnly}
          onClick={() => toggle(task)}
          style={done ? undefined : { borderColor: listColorOf(task) }}
          type="button"
        >
          {done ? <CheckIcon size={10} /> : null}
        </button>
        <button
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
          onClick={() => onEdit(task)}
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
      <form
        className="flex items-center gap-2 border-t border-hairline px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <PlusIcon className="shrink-0 text-ink-secondary" size={14} />
        <input
          aria-label="Add a task"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-secondary"
          data-testid="panel-add-task"
          disabled={!target}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={target ? `Add a task to ${target.title}` : 'No task list to add to'}
          value={title}
        />
      </form>
    </div>
  );
}
