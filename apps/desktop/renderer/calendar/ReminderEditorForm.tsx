import {
  REMINDER_ALARM_OPTIONS,
  REMINDER_PRIORITY_OPTIONS,
  type useTaskEditorModel,
} from '@calendar/app-state';
import type { RecurrenceFrequency, TaskRecord } from '@calendar/core';
import {
  FIELD_CLASS,
  LABEL_CLASS,
  REPEAT_ENDS_OPTIONS,
  REPEAT_OPTIONS,
} from './taskEditorOptions.ts';

const segment = (active: boolean) =>
  `rounded-md px-2 py-1 text-xs font-medium ${
    active ? 'bg-blue-600 text-white' : 'text-neutral-600 hover:bg-neutral-200/60'
  }`;

/**
 * The Reminders form — what EventKit can do that Google Tasks cannot: a
 * due time, priority, an alert, a repeat rule, a URL, and moving between
 * lists. Same Title placeholder and Delete/Cancel/Save labels as the
 * Google form so the shell and the e2e suite stay provider-agnostic.
 */
export function ReminderEditorForm({
  onClose,
  task,
  taskModel,
}: {
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
          className="rounded-lg bg-neutral-100 p-2 text-sm text-neutral-600"
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
      <label className={LABEL_CLASS}>
        List
        <select
          aria-label="Reminders list"
          className={`${FIELD_CLASS} mt-1`}
          // Reminders can move between lists (EKReminder.calendar is settable).
          disabled={Boolean(task) && !taskModel.canMoveList}
          onChange={(input) => taskModel.setListKey(input.target.value)}
          value={taskModel.listKey}
        >
          {taskModel.taskLists.map((list) => (
            <option key={`${list.accountId}:${list.id}`} value={`${list.accountId}:${list.id}`}>
              {list.title}
            </option>
          ))}
        </select>
      </label>
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
      <div>
        <span className={LABEL_CLASS}>Priority</span>
        <div
          aria-label="Priority"
          className="mt-1 flex rounded-lg border border-neutral-200 bg-neutral-50 p-0.5"
          role="radiogroup"
        >
          {REMINDER_PRIORITY_OPTIONS.map((option) => (
            <button
              aria-checked={taskModel.priority === option.value}
              className={`flex-1 ${segment(taskModel.priority === option.value)}`}
              key={option.label}
              onClick={() => taskModel.setPriority(option.value)}
              role="radio"
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
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
        <p className="text-xs text-neutral-500">
          This reminder repeats on a schedule Solunivo cannot edit — change it in Reminders.
        </p>
      ) : (
        <>
          <label className={LABEL_CLASS}>
            Repeat
            <select
              className={`${FIELD_CLASS} mt-1`}
              onChange={(input) =>
                taskModel.setRepeat(input.target.value as RecurrenceFrequency | 'none')
              }
              value={taskModel.repeat}
            >
              {REPEAT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {taskModel.repeat === 'none' ? null : (
            <div className="flex gap-3">
              <label className={`${LABEL_CLASS} w-24`}>
                Every (n)
                <input
                  className={`${FIELD_CLASS} mt-1`}
                  min={1}
                  onChange={(input) => taskModel.setRepeatInterval(input.target.value)}
                  type="number"
                  value={taskModel.repeatInterval}
                />
              </label>
              <label className={`${LABEL_CLASS} flex-1`}>
                Ends
                <select
                  className={`${FIELD_CLASS} mt-1`}
                  onChange={(input) => {
                    const value = input.target.value as 'after' | 'never' | 'on';
                    taskModel.setRepeatEnds(value);
                    if (value === 'on' && !taskModel.repeatUntil) {
                      taskModel.setRepeatUntil(taskModel.dueDate);
                    }
                  }}
                  value={taskModel.repeatEnds}
                >
                  {REPEAT_ENDS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {taskModel.repeatEnds === 'after' ? (
                <label className={`${LABEL_CLASS} w-24`}>
                  Times
                  <input
                    className={`${FIELD_CLASS} mt-1`}
                    min={1}
                    onChange={(input) => taskModel.setRepeatCount(input.target.value)}
                    type="number"
                    value={taskModel.repeatCount}
                  />
                </label>
              ) : null}
              {taskModel.repeatEnds === 'on' ? (
                <label className={`${LABEL_CLASS} flex-1`}>
                  Until
                  <input
                    className={`${FIELD_CLASS} mt-1`}
                    onChange={(input) => taskModel.setRepeatUntil(input.target.value)}
                    type="date"
                    value={taskModel.repeatUntil}
                  />
                </label>
              ) : null}
            </div>
          )}
        </>
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
      <div className="mt-2 flex items-center justify-between">
        {task && !taskModel.readOnly ? (
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
          {taskModel.readOnly ? null : (
            <button
              className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
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
