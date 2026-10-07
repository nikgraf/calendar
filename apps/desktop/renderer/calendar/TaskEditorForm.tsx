import type { useMoveConfirmation, useTaskEditorModel } from '@calendar/app-state';
import type { TaskRecord } from '@calendar/core';
import { Button } from '../ui/Button.tsx';
import { MoveConfirm } from './MoveConfirm.tsx';
import { TaskDoneToggle } from './TaskDoneToggle.tsx';
import { NoDueDate } from './NoDueDate.tsx';
import { FIELD_CLASS, LABEL_CLASS } from '../ui/fieldStyles.ts';
import { TaskListSelect } from './TaskListSelect.tsx';

/**
 * The Google Tasks form: title, due day, list, notes. Picking a list in
 * another account or provider moves the task on Save. The e2e suite
 * relies on the Title placeholder and the Delete/Cancel/Save labels.
 */
export function TaskEditorForm({
  moveConfirmation,
  onClose,
  task,
  taskModel,
}: {
  moveConfirmation: ReturnType<typeof useMoveConfirmation>;
  onClose: () => void;
  task: TaskRecord | undefined;
  taskModel: ReturnType<typeof useTaskEditorModel>;
}) {
  return (
    <div className="flex flex-col gap-3">
      {taskModel.error ? (
        <p className="select-text rounded-control bg-fill p-2 text-sm text-danger">
          {taskModel.error}
        </p>
      ) : null}
      <input
        autoFocus={!task}
        className={FIELD_CLASS}
        onChange={(input) => taskModel.setTitle(input.target.value)}
        placeholder="Title"
        value={taskModel.title}
      />
      {task ? <TaskDoneToggle task={task} /> : null}
      {taskModel.dated ? (
        <label className={LABEL_CLASS}>
          Due
          <input
            className={`${FIELD_CLASS} mt-1`}
            onChange={(input) => taskModel.setDueDate(input.target.value)}
            placeholder="YYYY-MM-DD"
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
      <MoveConfirm moveConfirmation={moveConfirmation} />
      <div className="mt-2 flex items-center justify-between">
        {task ? (
          <Button
            aria-busy={taskModel.busy}
            onClick={() => void taskModel.remove()}
            size="sm"
            variant="danger"
          >
            Delete
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button onClick={onClose} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            aria-busy={taskModel.busy}
            disabled={moveConfirmation.pending !== null}
            onClick={() => void taskModel.save()}
            size="sm"
            variant="primary"
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
