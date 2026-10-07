import { LABEL_CLASS } from './taskEditorOptions.ts';

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
          className="shrink-0 text-primary hover:underline"
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
