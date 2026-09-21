import type { useMoveConfirmation, useTaskEditorModel } from '@calendar/app-state';
import type { TaskRecord } from '@calendar/core';
import { MoveConfirm } from './MoveConfirm.tsx';
import { FIELD_CLASS, LABEL_CLASS } from './taskEditorOptions.ts';
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
        <p className="select-text rounded-lg bg-red-50 p-2 text-sm text-red-700">
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
      <label className={LABEL_CLASS}>
        Due
        <input
          className={`${FIELD_CLASS} mt-1`}
          onChange={(input) => taskModel.setDueDate(input.target.value)}
          placeholder="YYYY-MM-DD"
          value={taskModel.dueDate}
        />
      </label>
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
          className="self-start text-sm text-blue-600 hover:underline"
          onClick={() => window.open(task.webViewLink ?? '', '_blank', 'noopener')}
          type="button"
        >
          Open in Google Tasks
        </button>
      ) : null}
      <MoveConfirm moveConfirmation={moveConfirmation} />
      <div className="mt-2 flex items-center justify-between">
        {task ? (
          <button
            className="text-sm text-red-600 hover:underline"
            onClick={() => void taskModel.remove()}
            type="button"
          >
            Delete
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <button
            className="rounded-lg px-3 py-1.5 text-sm hover:bg-neutral-200"
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
            disabled={moveConfirmation.pendingSummary !== null}
            onClick={() => void taskModel.save()}
            type="button"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
