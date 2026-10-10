import type { PendingOpDiffLine } from '../backend.ts';
import { reminderLabel } from '../notifications/eventReminders.ts';
import { recurrenceLabel } from '../recurrence/label.ts';
import { toStructuredRules } from '../recurrence/structured.ts';
import { Temporal } from '../time/temporal.ts';
import type { EventRecord, PendingOp, TaskRecord } from '../types.ts';
import { eventFieldPairs, orNone, plainDateLabel } from './conflict.ts';

/**
 * What a queued change does, field by field, for the unsynced-changes
 * list: the op's `before*` snapshot against what it sends. A create lists
 * the fields it sets, a delete names what goes, an edit only what differs.
 * Undefined when the op predates the snapshot (nothing to compare).
 */
export interface PendingOpDiffContext {
  /** A calendar's name for a move's "from → to"; ids are unique per account only. */
  readonly calendarName: (accountId: string, calendarId: string) => string | undefined;
  /** The zone times read in — the primary zone, like the conflict banner. */
  readonly timeZone: string;
}

/**
 * One displayed field. `neutral` is the value an unset field shows
 * ("none", "Busy"): a create lists only fields that differ from it.
 * `identity` fields (title, time, due day) are what a delete names.
 */
interface FieldPair {
  readonly identity?: true;
  readonly label: string;
  readonly neutral?: string;
  readonly value: string;
}

const RESPONSE_LABEL: Record<string, string> = {
  accepted: 'Accepted',
  declined: 'Declined',
  needsAction: 'No response',
  tentative: 'Maybe',
};

const VISIBILITY_LABEL: Record<string, string> = {
  confidential: 'Private',
  default: 'Default',
  private: 'Private',
  public: 'Public',
};

/** The attendee whose answer this is: the user's own when marked, else the one that changed. */
const responseLabel = (
  event: EventRecord,
  other: EventRecord | null,
): { readonly label: string; readonly value: string } | undefined => {
  const attendees = event.attendees ?? [];
  const self = attendees.find((attendee) => attendee.isSelf);
  const changed =
    self ??
    attendees.find((attendee) => {
      const twin = other?.attendees?.find((candidate) => candidate.email === attendee.email);
      return twin !== undefined && twin.responseStatus !== attendee.responseStatus;
    });
  return changed
    ? {
        label: self ? 'Response' : `Response (${changed.displayName ?? changed.email})`,
        value: RESPONSE_LABEL[changed.responseStatus] ?? changed.responseStatus,
      }
    : undefined;
};

/** "Weekly on Monday", "Every 2 weeks, until Sep 30, 2026" — "Custom" for what the label cannot say. */
const repeatLabel = (event: EventRecord, timeZone: string): string => {
  const lines = event.recurrence ?? [];
  if (lines.length === 0) {
    return 'Does not repeat';
  }
  const { rules } = toStructuredRules(lines, event.isAllDay, event.startTimeZone ?? timeZone);
  const [rule] = rules;
  if (rules.length !== 1 || rule === undefined) {
    return 'Custom';
  }
  const untilDate =
    rule.untilDate ??
    (rule.untilUtc === undefined
      ? undefined
      : Temporal.Instant.fromEpochMilliseconds(rule.untilUtc)
          .toZonedDateTimeISO(timeZone)
          .toPlainDate()
          .toString());
  return recurrenceLabel({ ...rule, untilDate });
};

const remindersLabel = (event: EventRecord): string => {
  const reminders = event.reminders;
  if (reminders === undefined || reminders.useDefault) {
    return 'Calendar default';
  }
  if (reminders.overrides.length === 0) {
    return 'none';
  }
  return reminders.overrides
    .map(
      (override) =>
        reminderLabel(override.minutes, event.isAllDay) +
        (override.method === 'email' ? ' (email)' : ''),
    )
    .join(', ');
};

const eventPairs = (
  event: EventRecord,
  other: EventRecord | null,
  timeZone: string,
): ReadonlyArray<FieldPair> => {
  const base = eventFieldPairs(event, timeZone).map(([label, value]): FieldPair =>
    label === 'Title' || label === 'Time'
      ? { identity: true, label, value }
      : { label, neutral: 'none', value },
  );
  const response = responseLabel(event, other);
  return [
    ...base,
    ...(response ? [{ label: response.label, neutral: 'No response', value: response.value }] : []),
    { label: 'Repeat', neutral: 'Does not repeat', value: repeatLabel(event, timeZone) },
    { label: 'Reminders', neutral: 'Calendar default', value: remindersLabel(event) },
    {
      label: 'Shown as',
      neutral: 'Busy',
      value: event.transparency === 'transparent' ? 'Free' : 'Busy',
    },
    {
      label: 'Visibility',
      neutral: 'Default',
      value: VISIBILITY_LABEL[event.visibility ?? 'default'] ?? 'Default',
    },
  ];
};

const taskPairs = (task: TaskRecord): ReadonlyArray<FieldPair> => [
  { identity: true, label: 'Title', value: task.title || '(no title)' },
  {
    identity: true,
    label: 'Due',
    neutral: 'none',
    value: task.dueDate === undefined ? 'none' : plainDateLabel(task.dueDate),
  },
  { label: 'Notes', neutral: 'none', value: orNone(task.notes) },
  { label: 'Status', neutral: 'Open', value: task.status === 'completed' ? 'Completed' : 'Open' },
];

/**
 * The lines between two sides, paired by position (both builders emit the
 * same fields in the same order, bar a response line — matched by label).
 */
const linesBetween = (
  before: ReadonlyArray<FieldPair> | null,
  after: ReadonlyArray<FieldPair> | null,
): ReadonlyArray<PendingOpDiffLine> => {
  if (before === null && after === null) {
    return [];
  }
  if (before === null) {
    return (after ?? [])
      .filter((pair) => pair.neutral === undefined || pair.value !== pair.neutral)
      .map((pair) => ({ after: pair.value, before: null, label: pair.label }));
  }
  if (after === null) {
    return before
      .filter((pair) => pair.identity)
      .map((pair) => ({ after: null, before: pair.value, label: pair.label }));
  }
  const afterByLabel = new Map(after.map((pair) => [pair.label, pair.value]));
  return before.flatMap((pair) => {
    const value = afterByLabel.get(pair.label);
    return value === undefined || value === pair.value
      ? []
      : [{ after: value, before: pair.value, label: pair.label }];
  });
};

const eventLines = (
  before: EventRecord | null,
  after: EventRecord | null,
  timeZone: string,
): ReadonlyArray<PendingOpDiffLine> =>
  linesBetween(
    before ? eventPairs(before, after, timeZone) : null,
    after ? eventPairs(after, before, timeZone) : null,
  );

const taskLines = (
  before: TaskRecord | null,
  after: TaskRecord | null,
): ReadonlyArray<PendingOpDiffLine> =>
  linesBetween(before ? taskPairs(before) : null, after ? taskPairs(after) : null);

/** The task a createTask op inserts, from the fields it carries. */
const createdTask = (op: PendingOp): TaskRecord =>
  ({
    accountId: op.accountId,
    dueDate: op.taskDue,
    id: op.eventId,
    listId: op.taskListId ?? op.calendarId,
    notes: op.taskNotes,
    provider: 'google',
    status: 'needsAction',
    title: op.taskTitle ?? '',
    updatedAt: op.createdAt,
  }) as TaskRecord;

/** What a queued change does, or undefined when there is nothing to compare it against. */
export const pendingOpDiff = (
  op: PendingOp,
  context: PendingOpDiffContext,
): ReadonlyArray<PendingOpDiffLine> | undefined => {
  const { timeZone } = context;
  switch (op.kind) {
    case 'create':
      return op.payload ? eventLines(null, op.payload, timeZone) : undefined;
    case 'rsvp':
    case 'update':
      return op.beforePayload === undefined || !op.payload
        ? undefined
        : eventLines(op.beforePayload, op.payload, timeZone);
    case 'delete': {
      // A tombstone payload (an occurrence) still names what goes.
      const before = op.beforePayload ?? op.payload;
      return before ? eventLines(before, null, timeZone) : undefined;
    }
    case 'move':
      return op.targetCalendarId === undefined
        ? undefined
        : [
            {
              after: context.calendarName(op.accountId, op.targetCalendarId) ?? op.targetCalendarId,
              before: context.calendarName(op.accountId, op.calendarId) ?? op.calendarId,
              label: 'Calendar',
            },
          ];
    case 'calendarColor':
      return op.colorHex === undefined
        ? undefined
        : [{ after: op.colorHex, before: op.beforeColorHex ?? null, label: 'Color' }];
    case 'createTask':
      return taskLines(null, createdTask(op));
    case 'updateTask':
      return op.beforeTask
        ? taskLines(op.beforeTask, {
            ...op.beforeTask,
            ...(op.taskDue === undefined ? {} : { dueDate: op.taskDue }),
            ...(op.taskNotes === undefined ? {} : { notes: op.taskNotes }),
            ...(op.taskTitle === undefined ? {} : { title: op.taskTitle }),
          })
        : undefined;
    case 'completeTask':
      return op.beforeTask && op.taskStatus
        ? taskLines(op.beforeTask, { ...op.beforeTask, status: op.taskStatus })
        : undefined;
    case 'deleteTask':
      return op.beforeTask ? taskLines(op.beforeTask, null) : undefined;
  }
};
