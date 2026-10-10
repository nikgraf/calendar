import type { PendingOp } from '@calendar/core';

const KIND_LABEL: Record<PendingOp['kind'], string> = {
  calendarColor: 'Color',
  completeTask: 'Task',
  create: 'Create',
  createTask: 'New task',
  delete: 'Delete',
  deleteTask: 'Delete task',
  move: 'Move',
  rsvp: 'RSVP',
  update: 'Update',
  updateTask: 'Edit task',
};

/** Long enough for a status and Google's message, short enough for one row. */
const REASON_MAX = 160;

/** The first line of a recorded failure, capped: a defect's stack is not for the list. */
const reasonLine = (lastError: string): string | null => {
  const line = lastError.trim().split('\n', 1)[0]?.trim() ?? '';
  if (line === '') {
    return null;
  }
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 1)}…` : line;
};

/**
 * One line for the unsynced-changes list: "<kind> · <subject>", plus the
 * retry note when the op has failed before (or the conflict note while a
 * 412 has it parked), and why the last attempt failed. Desktop had the
 * label map and iOS printed raw kinds ("createTask"); both use this now.
 * Without the reason, an op retrying forever said only that it was — the
 * cause sat in the database of a phone nobody can read.
 */
export const pendingOpLabel = (op: {
  readonly attempts: number;
  readonly calendarId: string;
  readonly conflict?: unknown;
  readonly eventId: string;
  readonly kind: PendingOp['kind'];
  readonly lastError?: string | undefined;
  readonly title?: string | undefined;
}): {
  readonly reason: string | null;
  readonly retry: string | null;
  readonly text: string;
} => ({
  reason:
    op.conflict === undefined && op.attempts > 0 && op.lastError !== undefined
      ? reasonLine(op.lastError)
      : null,
  retry:
    op.conflict !== undefined
      ? 'changed on Google — choose a version'
      : op.attempts > 0
        ? `retrying (${String(op.attempts)}×)`
        : null,
  text: `${KIND_LABEL[op.kind]} · ${op.kind === 'calendarColor' ? op.calendarId : (op.title ?? op.eventId)}`,
});
