import { TaskRecord } from '@calendar/core';
import { describe, expect, it, vi } from 'vite-plus/test';
import { taskDetailAction } from './taskDetailActions.ts';

const reminder = (overrides: Partial<TaskRecord> = {}) =>
  new TaskRecord({
    accountId: 'apple-reminders',
    id: 'reminder',
    listId: 'home',
    provider: 'apple',
    status: 'needsAction',
    title: 'Call Alex',
    updatedAt: 0,
    ...overrides,
  });
const setup = () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  mutations: {
    completeTask: vi.fn(() => Promise.resolve()),
    deleteTask: vi.fn(() => Promise.resolve()),
    previewDeleteTask: vi.fn(() => Promise.resolve({ subtasks: 2 })),
  },
  readOnly: false,
});

describe('taskDetailAction', () => {
  it('completes and reopens the current reminder after it moves to another list', async () => {
    const context = setup();
    const task = reminder({ listId: 'work' });
    expect(await taskDetailAction({ ...context, action: 'complete', task })).toBe(true);
    expect(context.mutations.completeTask).toHaveBeenLastCalledWith({
      accountId: task.accountId,
      status: 'completed',
      taskId: task.id,
      taskListId: 'work',
    });
    expect(
      await taskDetailAction({
        ...context,
        action: 'complete',
        task: reminder({ listId: 'other', status: 'completed' }),
      }),
    ).toBe(true);
    expect(context.mutations.completeTask).toHaveBeenLastCalledWith({
      accountId: task.accountId,
      status: 'needsAction',
      taskId: task.id,
      taskListId: 'other',
    });
  });

  it('previews subtasks and confirms before deleting the current row', async () => {
    const context = setup();
    const task = reminder({ listId: 'work', title: 'Call Alex (updated)' });
    expect(await taskDetailAction({ ...context, action: 'delete', task })).toBe(true);
    expect(context.confirm).toHaveBeenCalledWith({
      kind: 'delete',
      subject: 'task',
      summary: 'Delete “Call Alex (updated)” and its 2 subtasks?',
    });
    expect(context.mutations.deleteTask).toHaveBeenCalledWith({
      accountId: task.accountId,
      taskId: task.id,
      taskListId: 'work',
    });
  });

  it('leaves the detail open when deletion is declined or its backend write fails', async () => {
    const context = setup();
    context.confirm.mockResolvedValue(false);
    expect(await taskDetailAction({ ...context, action: 'delete', task: reminder() })).toBe(false);
    expect(context.mutations.deleteTask).not.toHaveBeenCalled();
    context.mutations.completeTask.mockRejectedValue(new Error('Unavailable'));
    await expect(
      taskDetailAction({ ...context, action: 'complete', task: reminder() }),
    ).rejects.toThrow('Unavailable');
  });

  it('does not mutate or ask about a read-only reminder', async () => {
    const context = setup();
    for (const action of ['complete', 'delete'] as const) {
      expect(await taskDetailAction({ ...context, action, readOnly: true, task: reminder() })).toBe(
        false,
      );
    }
    expect(context.mutations.completeTask).not.toHaveBeenCalled();
    expect(context.mutations.previewDeleteTask).not.toHaveBeenCalled();
    expect(context.mutations.deleteTask).not.toHaveBeenCalled();
    expect(context.confirm).not.toHaveBeenCalled();
  });
});
