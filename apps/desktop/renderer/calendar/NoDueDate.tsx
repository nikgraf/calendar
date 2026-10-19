import { LABEL_CLASS } from '../ui/fieldStyles.ts';
import { TEXT_ACTION_CLASS } from '../ui/buttonStyles.ts';

/**
 * Beside the Due label: takes the day away, so the task is saved undated
 * (an inbox add, or back to the inbox). Nothing where the model keeps the
 * day (a conversion, a read-only reminder).
 */
export function RemoveDueDate({ onRemove }: { onRemove: (() => void) | undefined }) {
  return onRemove ? (
    <button
      className={`text-xs ${TEXT_ACTION_CLASS.primary}`}
      data-testid="task-remove-due-date"
      onClick={onRemove}
      type="button"
    >
      No due date
    </button>
  ) : null;
}

/**
 * The Due row of a task that has no due day: the calendar shows it on
 * today until it is done, and it keeps no date unless one is added here.
 */
export function NoDueDate({ onAdd }: { onAdd: () => void }) {
  return (
    <div data-testid="task-no-due-date">
      <span className={LABEL_CLASS}>Due</span>
      <p className="mt-1 flex items-center justify-between gap-3 text-sm text-ink-secondary">
        No due date — shown on today until it is done.
        <button
          className={`shrink-0 ${TEXT_ACTION_CLASS.primary}`}
          data-testid="task-add-due-date"
          onClick={onAdd}
          type="button"
        >
          Add due date
        </button>
      </p>
    </div>
  );
}
