import { describe, expect, it } from 'vitest';
import { mapGcalTask } from './mapTask.ts';

const CONTEXT = { accountId: 'acc-1', taskListId: 'list-1' };

describe('mapGcalTask', () => {
  it('keeps only the date from due — the API discards the time portion', () => {
    const task = mapGcalTask(
      { due: '2026-08-30T00:00:00.000Z', id: 't1', status: 'needsAction', title: 'Pay rent' },
      CONTEXT,
    );
    expect(task?.dueDate).toBe('2026-08-30');
  });

  it('returns null for tombstones', () => {
    expect(mapGcalTask({ deleted: true, id: 't1' }, CONTEXT)).toBeNull();
  });

  it('falls back to needsAction on unknown statuses', () => {
    const task = mapGcalTask({ id: 't1', status: 'someFutureStatus', title: 'x' }, CONTEXT);
    expect(task?.status).toBe('needsAction');
  });

  it('parses the completion timestamp', () => {
    const task = mapGcalTask(
      { completed: '2026-08-23T10:00:00.000Z', id: 't1', status: 'completed', title: 'x' },
      CONTEXT,
    );
    expect(task?.completedAt).toBe(Date.parse('2026-08-23T10:00:00.000Z'));
    expect(task?.status).toBe('completed');
  });

  it('leaves undated tasks without a dueDate', () => {
    const task = mapGcalTask({ id: 't1', title: 'someday' }, CONTEXT);
    expect(task?.dueDate).toBeUndefined();
  });
});
