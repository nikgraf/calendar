import type { PendingOp } from '@calendar/core';

const KIND_LABEL: Record<PendingOp['kind'], string> = {
  calendarColor: 'Color',
  completeTask: 'Task',
  create: 'Create',
  createTask: 'New task',
  delete: 'Delete',
  deleteTask: 'Delete task',
  rsvp: 'RSVP',
  update: 'Update',
  updateTask: 'Edit task',
};

/**
 * One line for the unsynced-changes list: "<kind> · <subject>", plus the
 * retry note when the op has failed before. Desktop had the label map
 * and iOS printed raw kinds ("createTask"); both use this now.
 */
export const pendingOpLabel = (op: {
  readonly attempts: number;
  readonly calendarId: string;
  readonly eventId: string;
  readonly kind: PendingOp['kind'];
  readonly title?: string | undefined;
}): { readonly retry: string | null; readonly text: string } => ({
  retry: op.attempts > 0 ? `retrying (${String(op.attempts)}×)` : null,
  text: `${KIND_LABEL[op.kind]} · ${op.kind === 'calendarColor' ? op.calendarId : (op.title ?? op.eventId)}`,
});
