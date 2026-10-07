import { SegmentedControl } from '../ui/SegmentedControl.tsx';
import {
  REMINDER_ALARM_OPTIONS,
  REMINDER_PRIORITY_OPTIONS,
  type useMoveConfirmation,
  type useTaskEditorModel,
} from '@calendar/app-state';
import type { TaskRecord } from '@calendar/core';
import { MoveConfirm } from './MoveConfirm.tsx';
import { NoDueDate } from './NoDueDate.tsx';
import { RepeatRuleFields } from './RepeatRuleFields.tsx';
import { FIELD_CLASS, LABEL_CLASS } from '../ui/fieldStyles.ts';
import { TaskListSelect } from './TaskListSelect.tsx';

/**
 * The Reminders form — what EventKit can do that Google Tasks cannot: a
 * due time, priority, an alert, a repeat rule, a URL, and moving between
 * lists. Same Title placeholder and Delete/Cancel/Save labels as the
 * Google form so the shell and the e2e suite stay provider-agnostic.
 */
export function ReminderEditorForm({
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
    <fieldset className="flex flex-col gap-3" disabled={taskModel.readOnly}>
      {taskModel.error ? (
        <p className="select-text rounded-lg bg-red-50 p-2 text-sm text-red-700">
          {taskModel.error}
        </p>
      ) : null}
      {taskModel.readOnly ? (
        <p
          className="rounded-lg bg-fill p-2 text-sm text-ink-secondary"
          data-testid="task-read-only"
        >
          This list is read-only in Reminders.
        </p>
      ) : null}
      <input
        autoFocus={!task}
        className={FIELD_CLASS}
        onChange={(input) => taskModel.setTitle(input.target.value)}
        placeholder="Title"
        value={taskModel.title}
      />
      <TaskListSelect disabled={Boolean(task) && !taskModel.canMoveList} taskModel={taskModel} />
      {taskModel.dated ? (
        <div className="flex gap-3">
          <label className={`${LABEL_CLASS} flex-1`}>
            Due
            <input
              className={`${FIELD_CLASS} mt-1`}
              onChange={(input) => taskModel.setDueDate(input.target.value)}
              type="date"
              value={taskModel.dueDate}
            />
          </label>
          <label className={`${LABEL_CLASS} flex-1`}>
            <span className="flex items-center gap-2">
              <input
                aria-label="At a time"
                checked={taskModel.timed}
                onChange={(input) => taskModel.setTimed(input.target.checked)}
                type="checkbox"
              />
              Time
            </span>
            <input
              aria-label="Due time"
              className={`${FIELD_CLASS} mt-1`}
              disabled={!taskModel.timed}
              onChange={(input) => taskModel.setDueTime(input.target.value)}
              type="time"
              value={taskModel.dueTime}
            />
          </label>
        </div>
      ) : (
        <NoDueDate onAdd={taskModel.addDueDate} />
      )}
      <div>
        <span className={LABEL_CLASS}>Priority</span>
        <SegmentedControl
          className="mt-1 w-full"
          grow
          label="Priority"
          onChange={(value) =>
            taskModel.setPriority(
              REMINDER_PRIORITY_OPTIONS.find((option) => option.label === value)?.value,
            )
          }
          options={REMINDER_PRIORITY_OPTIONS.map((option) => ({
            label: option.label,
            value: option.label,
          }))}
          size="sm"
          value={
            REMINDER_PRIORITY_OPTIONS.find((option) => option.value === taskModel.priority)
              ?.label ?? 'None'
          }
        />
      </div>
      <label className={LABEL_CLASS}>
        Alert
        <select
          className={`${FIELD_CLASS} mt-1`}
          onChange={(input) =>
            taskModel.setAlarm(input.target.value === '' ? undefined : Number(input.target.value))
          }
          value={taskModel.alarm === undefined ? '' : String(taskModel.alarm)}
        >
          {REMINDER_ALARM_OPTIONS.map((option) => (
            <option
              key={option.label}
              value={option.value === undefined ? '' : String(option.value)}
            >
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {taskModel.recurrenceUnsupported ? (
        <p className="text-xs text-ink-secondary">
          This reminder repeats on a schedule Solunivo cannot edit — change it in Reminders.
        </p>
      ) : (
        <RepeatRuleFields anchorDate={taskModel.dueDate} state={taskModel} />
      )}
      <label className={LABEL_CLASS}>
        URL
        <input
          className={`${FIELD_CLASS} mt-1`}
          onChange={(input) => taskModel.setUrl(input.target.value)}
          placeholder="https://"
          type="url"
          value={taskModel.url}
        />
      </label>
      <label className={LABEL_CLASS}>
        Notes
        <textarea
          className={`${FIELD_CLASS} mt-1 min-h-16`}
          onChange={(input) => taskModel.setNotes(input.target.value)}
          placeholder="Add notes"
          value={taskModel.notes}
        />
      </label>
      <MoveConfirm moveConfirmation={moveConfirmation} />
      <div className="mt-2 flex items-center justify-between">
        {task && !taskModel.readOnly ? (
          <button
            aria-busy={taskModel.busy}
            className={`text-sm text-red-600 hover:underline ${taskModel.busy ? 'opacity-40' : ''}`}
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
            className="rounded-lg px-3 py-1.5 text-sm hover:bg-fill"
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          {taskModel.readOnly ? null : (
            <button
              aria-busy={taskModel.busy}
              className={`rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:opacity-40 ${taskModel.busy ? 'opacity-40' : ''}`}
              disabled={moveConfirmation.pending !== null}
              onClick={() => void taskModel.save()}
              type="button"
            >
              Save
            </button>
          )}
        </div>
      </div>
    </fieldset>
  );
}
