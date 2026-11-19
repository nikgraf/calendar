import { isValidElement, type ReactNode } from 'react';
import { TaskRecord } from '@calendar/core';
import { expect, it, vi } from 'vite-plus/test';

const state = vi.hoisted(() => ({
  completeTask: vi.fn(() => Promise.resolve()),
  running: undefined as Promise<void> | undefined,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: () => {},
  useEffectEvent: (callback: () => void) => callback,
  useState: <T,>(value: T) => [value, () => {}],
}));
vi.mock('react-native', () => ({
  Linking: {},
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View',
}));
vi.mock('./theme.ts', () => ({ BOX_FONT_SCALE: 1.35, useStyles: () => ({}) }));
vi.mock('./EventEditSheet.tsx', () => ({ confirmEditorRequest: vi.fn() }));
vi.mock('@calendar/app-state', async () => ({
  reminderAlarmLabel: () => '',
  taskDetailAction: (await import('../../../../packages/app-state/src/taskDetailActions.ts'))
    .taskDetailAction,
  useAction: () => ({
    busy: false,
    error: null,
    run: (write: () => Promise<void>) => {
      state.running = write();
      return state.running;
    },
  }),
  useBackendMutations: () => ({ completeTask: state.completeTask }),
  useCurrentTask: (task: TaskRecord) => task,
  // The former form model could not toggle after the saved row moved:
  // its seeded destination still named the previous list.
  useTaskEditorModel: () => ({ busy: false, readOnly: false, toggleCompletion: undefined }),
  useTaskReadOnlyLookup: () => () => false,
}));

const { TaskDetailSheet } = await import('./TaskDetailSheet.tsx');

const press = (node: ReactNode, testID: string): (() => void) | undefined => {
  if (!isValidElement<{ children?: ReactNode; onPress?: () => void; testID?: string }>(node)) {
    return undefined;
  }
  if (node.props.testID === testID) {
    return node.props.onPress;
  }
  const children = node.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = press(child, testID);
    if (found) {
      return found;
    }
  }
  return undefined;
};

it('completes the current reminder after its list changes while its detail is open', async () => {
  const task = new TaskRecord({
    accountId: 'apple-reminders',
    id: 'reminder',
    listId: 'work',
    provider: 'apple',
    status: 'needsAction',
    title: 'Call Alex',
    updatedAt: 1,
  });
  const onCompleted = vi.fn();
  const view = TaskDetailSheet({
    onClose: vi.fn(),
    onCompleted,
    onEdit: vi.fn(),
    task,
    taskLists: [],
  });
  const complete = press(view, 'task-detail-complete');
  expect(complete).toBeDefined();
  complete!();
  await state.running;
  expect(state.completeTask).toHaveBeenCalledWith({
    accountId: 'apple-reminders',
    status: 'completed',
    taskId: 'reminder',
    taskListId: 'work',
  });
  expect(onCompleted).toHaveBeenCalledWith(task, 'complete');
});
