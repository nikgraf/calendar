import { Effect } from 'effect';
import { RemindersAccessError, type RemindersClientShape } from './client.ts';
import type { ReminderJson, ReminderListJson, RemindersAuthorization } from './protocol.ts';

/**
 * In-memory RemindersClient for tests: a mutable store of lists and
 * reminders with the same semantics as the Swift bridge (server-assigned
 * ids, null clears, list moves, windowed listing). Tests read `state`
 * directly to assert what EventKit "saw".
 */
export interface FakeRemindersState {
  authorization: RemindersAuthorization;
  readonly calls: Array<string>;
  readonly lists: Map<string, ReminderListJson>;
  nextId: number;
  readonly reminders: Map<string, ReminderJson>;
}

const apply = (base: ReminderJson, changes: Record<string, unknown>, now: number): ReminderJson => {
  const next: Record<string, unknown> = { ...base, updatedAt: now };
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'listId' && typeof value === 'string') {
      next['listId'] = value;
    } else if (value === null) {
      delete next[key];
      if (key === 'alarms') {
        next['alarms'] = [];
      }
    } else if (value !== undefined) {
      next[key] = value;
    }
  }
  if (next['dueDate'] === undefined) {
    delete next['dueTime'];
  }
  return next as unknown as ReminderJson;
};

export const makeFakeRemindersClient = (
  initial: {
    readonly authorization?: RemindersAuthorization;
    readonly lists?: ReadonlyArray<ReminderListJson>;
    readonly reminders?: ReadonlyArray<ReminderJson>;
  } = {},
): { readonly client: RemindersClientShape; readonly state: FakeRemindersState } => {
  const state: FakeRemindersState = {
    authorization: initial.authorization ?? 'fullAccess',
    calls: [],
    lists: new Map((initial.lists ?? []).map((list) => [list.id, list])),
    nextId: 1,
    reminders: new Map((initial.reminders ?? []).map((reminder) => [reminder.id, reminder])),
  };

  const guard = <A>(method: string, run: () => A): Effect.Effect<A, RemindersAccessError> =>
    Effect.suspend(() => {
      state.calls.push(method);
      if (state.authorization !== 'fullAccess') {
        return Effect.fail(new RemindersAccessError({ authorization: state.authorization }));
      }
      return Effect.succeed(run());
    });

  const find = (id: string): ReminderJson => {
    const reminder = state.reminders.get(id);
    if (!reminder) {
      throw new Error(`notFound: ${id}`);
    }
    return reminder;
  };

  const client: RemindersClientShape = {
    create: ({ listId, reminder }) =>
      guard('create', () => {
        const id = `rem-${String(state.nextId++)}`;
        const now = Date.now();
        const created = apply(
          {
            alarms: [],
            completed: false,
            id,
            listId,
            priority: 0,
            title: '',
            updatedAt: now,
          },
          reminder as Record<string, unknown>,
          now,
        );
        state.reminders.set(id, created);
        return created;
      }),
    delete: ({ id }) =>
      guard('delete', () => {
        find(id);
        state.reminders.delete(id);
      }),
    list: ({ endDate, startDate }) =>
      guard('list', () =>
        [...state.reminders.values()].filter(
          (reminder) =>
            reminder.dueDate !== undefined &&
            reminder.dueDate >= startDate &&
            reminder.dueDate <= endDate,
        ),
      ),
    listLists: () => guard('listLists', () => [...state.lists.values()]),
    requestAccess: () =>
      Effect.sync(() => {
        state.calls.push('requestAccess');
        if (state.authorization === 'notDetermined') {
          state.authorization = 'fullAccess';
        }
        return state.authorization === 'fullAccess';
      }),
    setCompleted: ({ completed, id }) =>
      guard('setCompleted', () => {
        const now = Date.now();
        const next: ReminderJson = {
          ...find(id),
          completed,
          ...(completed ? { completedAt: now } : {}),
          updatedAt: now,
        };
        if (!completed) {
          delete (next as { completedAt?: number }).completedAt;
        }
        state.reminders.set(id, next);
        return next;
      }),
    status: () =>
      Effect.sync(() => {
        state.calls.push('status');
        return state.authorization;
      }),
    update: ({ changes, id }) =>
      guard('update', () => {
        const next = apply(find(id), changes as Record<string, unknown>, Date.now());
        state.reminders.set(id, next);
        return next;
      }),
  };

  return { client, state };
};
