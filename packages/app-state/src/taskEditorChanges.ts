import type { TaskPriority, TaskProvider, TaskRecurrence } from '@calendar/core';

/** The editor's fields in their submitted form (trimmed, timed-or-not resolved). */
export interface TaskEditorValues {
  /** The first relative alert (minutes); undefined = none. */
  readonly alarm: number | undefined;
  readonly dueDate: string;
  /** Undefined when the reminder is all-day. */
  readonly dueTime: string | undefined;
  readonly listId: string;
  readonly notes: string;
  readonly priority: TaskPriority | undefined;
  readonly recurrence: TaskRecurrence | undefined;
  readonly title: string;
  readonly url: string;
}

/** What `updateTask` accepts — mirrors the rpc payload in @calendar/core. */
export interface TaskEditorChanges {
  readonly alarms?: ReadonlyArray<number> | null;
  readonly dueDate?: string;
  readonly dueTime?: string | null;
  readonly moveToListId?: string;
  readonly notes?: string;
  readonly priority?: TaskPriority | null;
  readonly recurrence?: TaskRecurrence | null;
  readonly title?: string;
  readonly url?: string | null;
}

const sameRecurrence = (a: TaskRecurrence | undefined, b: TaskRecurrence | undefined) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.freq === b.freq &&
    a.interval === b.interval &&
    a.count === b.count &&
    a.untilDate === b.untilDate);

/**
 * The fields to send on Save: only those that differ from what the editor
 * opened with. Reminders are edited from other apps too (Reminders.app,
 * Siri, another device) and the change push lands those edits in the
 * mirror within seconds — resending an untouched field would overwrite
 * such an edit with the stale value the form was seeded with. The
 * comparison is against the *opening* snapshot, not the live row: a
 * field the user never touched stays untouched whatever happened to it
 * meanwhile.
 *
 * `initialAlarms` is the whole alert list at open: the form edits the
 * first relative alert and any further alerts ride along unchanged.
 */
export const taskEditorChanges = ({
  current,
  initial,
  initialAlarms,
  provider,
  recurrenceUnsupported,
}: {
  readonly current: TaskEditorValues;
  readonly initial: TaskEditorValues;
  readonly initialAlarms: ReadonlyArray<number>;
  readonly provider: TaskProvider;
  readonly recurrenceUnsupported: boolean;
}): TaskEditorChanges => {
  const changes: {
    -readonly [K in keyof TaskEditorChanges]: TaskEditorChanges[K];
  } = {};
  if (current.title !== initial.title) {
    changes.title = current.title;
  }
  if (current.notes !== initial.notes) {
    changes.notes = current.notes;
  }
  if (current.dueDate !== initial.dueDate) {
    changes.dueDate = current.dueDate;
  }
  if (provider !== 'apple') {
    return changes;
  }
  if (current.alarm !== initial.alarm) {
    const alarms = [
      ...(current.alarm === undefined ? [] : [current.alarm]),
      ...initialAlarms.slice(1),
    ];
    changes.alarms = alarms.length === 0 ? null : alarms;
  }
  if (current.dueTime !== initial.dueTime) {
    changes.dueTime = current.dueTime ?? null;
  }
  if (current.listId !== initial.listId) {
    changes.moveToListId = current.listId;
  }
  if (current.priority !== initial.priority) {
    changes.priority = current.priority ?? null;
  }
  // Never overwrite a rule the form could not show.
  if (!recurrenceUnsupported && !sameRecurrence(current.recurrence, initial.recurrence)) {
    changes.recurrence = current.recurrence ?? null;
  }
  if (current.url !== initial.url) {
    changes.url = current.url || null;
  }
  return changes;
};
