import type { useTaskEditorModel } from '@calendar/app-state';
import type { TaskRecord } from '@calendar/core';
import { TaskDoneToggle } from './TaskDoneToggle.tsx';
import { NoDueDate, RemoveDueDate } from './NoDueDate.tsx';
import { FIELD_CLASS, LABEL_CLASS } from '../ui/fieldStyles.ts';
import { TaskListSelect } from './TaskListSelect.tsx';
import { useFieldFlash } from '../ui/useFlash.ts';

/**
 * The Google Tasks form: title, due day, list, notes. Picking a list in
 * another account or provider moves the task on Save; the panel's footer
 * carries Delete, Cancel and Save. The e2e suite relies on the Title
 * placeholder.
 */
export function TaskEditorForm({
  task,
  taskModel,
}: {
  task: TaskRecord | undefined;
  taskModel: ReturnType<typeof useTaskEditorModel>;
}) {
  // What the last turn changed tints and fades back (the thread's flash).
  const titleFlash = useFieldFlash<HTMLInputElement>('title');
  const dateFlash = useFieldFlash<HTMLInputElement>('date');
  return (
    <div className="flex flex-col gap-4">
      {taskModel.error ? (
        <p className="select-text rounded-control bg-fill p-2 text-sm text-danger">
          {taskModel.error}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        <input
          autoFocus={!task}
          className={`${FIELD_CLASS} py-2 text-base`}
          onChange={(input) => taskModel.setTitle(input.target.value)}
          placeholder="Title"
          ref={titleFlash}
          value={taskModel.title}
        />
        {task ? <TaskDoneToggle task={task} /> : null}
      </div>
      {taskModel.dated ? (
        <label className={LABEL_CLASS}>
          <span className="flex items-center justify-between">
            Due
            <RemoveDueDate onRemove={taskModel.clearDueDate} />
          </span>
          <input
            className={`${FIELD_CLASS} mt-1`}
            onChange={(input) => taskModel.setDueDate(input.target.value)}
            placeholder="YYYY-MM-DD"
            ref={dateFlash}
            value={taskModel.dueDate}
          />
        </label>
      ) : (
        <NoDueDate onAdd={taskModel.addDueDate} />
      )}
      <TaskListSelect disabled={Boolean(task) && !taskModel.canMoveList} taskModel={taskModel} />
      <label className={LABEL_CLASS}>
        Notes
        <textarea
          className={`${FIELD_CLASS} mt-1 min-h-16`}
          onChange={(input) => taskModel.setNotes(input.target.value)}
          placeholder="Add notes"
          value={taskModel.notes}
        />
      </label>
      {task?.webViewLink ? (
        <button
          className="self-start text-sm text-primary hover:underline"
          onClick={() => window.open(task.webViewLink ?? '', '_blank', 'noopener')}
          type="button"
        >
          Open in Google Tasks
        </button>
      ) : null}
    </div>
  );
}
