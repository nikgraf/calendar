import { isTaskListWritable } from '@calendar/core';
import { EventMutations, type TaskWriteChanges } from '@calendar/sync';
import { Effect } from 'effect';
import type { ToolInput } from '../contract.ts';
import { toTaskDto } from '../dto.ts';
import { type AgentPolicy, decideWrite } from '../policy.ts';
import { type Directory, resolveTask, resolveTaskList } from '../resolve.ts';
import { changeLine, listLine, summarize, textLine, titled } from '../summary.ts';
import { isIsoDate } from '../times.ts';
import { invalid, MAX_NOTES, MAX_TITLE, MAX_URL, checkText } from './limits.ts';
import type { WritePlan } from './plan.ts';

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/u;

const dueLine = (dueDate: string, dueTime: string | null | undefined): string =>
  `Due: ${dueDate}${dueTime ? ` ${dueTime}` : ''}`;

export const planCreateTask = (
  policy: AgentPolicy,
  directory: Directory,
  input: ToolInput<'create_task'>,
) =>
  Effect.gen(function* () {
    const granted = yield* resolveTaskList(directory, input.list);
    const { list } = granted;
    const title = input.title.trim();
    if (title === '') {
      return yield* invalid('title must not be empty.');
    }
    yield* checkText('title', title, MAX_TITLE);
    yield* checkText('notes', input.notes, MAX_NOTES);
    yield* checkText('url', input.url, MAX_URL);
    if (!isIsoDate(input.dueDate)) {
      return yield* invalid('dueDate must be a real date in YYYY-MM-DD form.');
    }
    if (input.dueTime !== undefined && !CLOCK.test(input.dueTime)) {
      return yield* invalid('dueTime must be HH:MM (24h).');
    }
    const plan: WritePlan<EventMutations> = {
      decision: decideWrite({
        guests: policy.guests,
        level: granted.level,
        providerWritable: isTaskListWritable(list),
        touchesGuests: false,
      }),
      run: Effect.gen(function* () {
        const record = yield* (yield* EventMutations).createTask({
          accountId: list.accountId,
          dueDate: input.dueDate,
          ...(input.dueTime === undefined ? {} : { dueTime: input.dueTime }),
          ...(input.notes ? { notes: input.notes } : {}),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          taskListId: list.id,
          title,
          ...(input.url === undefined ? {} : { url: input.url }),
        });
        return {
          status: 'done' as const,
          task: toTaskDto(record),
          // Google assigns the real id when the queued create lands; the
          // ref above then stops resolving.
          ...(list.provider === 'google'
            ? {
                note: 'The ref of a new Google task changes once it has synced: call list_tasks again before editing it.',
              }
            : {}),
        };
      }),
      summary: summarize(titled('Create', 'task', title), [
        listLine(list.title, directory.accountLabel(list.accountId)),
        dueLine(input.dueDate, input.dueTime),
        input.priority !== undefined && `Priority: ${input.priority}`,
        input.notes !== undefined && input.notes !== '' && textLine('Notes', input.notes),
        input.url !== undefined && textLine('Link', input.url),
      ]),
      what: 'Task list',
    };
    return plan;
  });

export const planUpdateTask = (
  policy: AgentPolicy,
  directory: Directory,
  input: ToolInput<'update_task'>,
) =>
  Effect.gen(function* () {
    const { granted, ref, task } = yield* resolveTask(directory, input.ref);
    const { list } = granted;
    const title = input.title?.trim();
    if (title === '') {
      return yield* invalid('title must not be empty.');
    }
    yield* checkText('title', title, MAX_TITLE);
    yield* checkText('notes', input.notes, MAX_NOTES);
    yield* checkText('url', input.url, MAX_URL);
    if (input.dueDate !== undefined && !isIsoDate(input.dueDate)) {
      return yield* invalid('dueDate must be a real date in YYYY-MM-DD form.');
    }
    if (typeof input.dueTime === 'string' && !CLOCK.test(input.dueTime)) {
      return yield* invalid('dueTime must be HH:MM (24h).');
    }
    // No moveToListId: an agent never moves a task between lists.
    const changes: TaskWriteChanges = {
      ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
      ...(input.dueTime === undefined ? {} : { dueTime: input.dueTime }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(title === undefined ? {} : { title }),
      ...(input.url === undefined ? {} : { url: input.url }),
    };
    const hasChanges = Object.keys(changes).length > 0;
    const toggles =
      input.completed !== undefined && input.completed !== (task.status === 'completed');
    if (!hasChanges && input.completed === undefined) {
      return yield* invalid('Nothing to change: send at least one field besides ref.');
    }
    const target = { accountId: ref.accountId, taskId: ref.taskId, taskListId: ref.taskListId };
    const plan: WritePlan<EventMutations> = {
      decision: decideWrite({
        guests: policy.guests,
        level: granted.level,
        providerWritable: isTaskListWritable(list),
        touchesGuests: false,
      }),
      run: Effect.gen(function* () {
        const mutations = yield* EventMutations;
        if (hasChanges) {
          yield* mutations.updateTask({ ...target, changes });
        }
        if (toggles) {
          yield* mutations.completeTask({
            ...target,
            status: input.completed ? 'completed' : 'needsAction',
          });
        }
        return { status: 'done' as const };
      }),
      summary: summarize(
        titled(
          !hasChanges && toggles ? (input.completed ? 'Complete' : 'Reopen') : 'Update',
          'task',
          task.title,
        ),
        [
          listLine(list.title, directory.accountLabel(list.accountId)),
          title !== undefined && title !== task.title && changeLine('Title', task.title, title),
          input.dueDate !== undefined && `Due: ${task.dueDate ?? '(none)'} → ${input.dueDate}`,
          input.dueTime !== undefined &&
            `Due time: ${task.dueTime ?? '(none)'} → ${input.dueTime ?? '(none)'}`,
          input.priority !== undefined &&
            `Priority: ${task.priority ?? '(none)'} → ${input.priority ?? '(none)'}`,
          input.notes !== undefined && changeLine('Notes', task.notes, input.notes),
          input.url !== undefined && `Link: ${task.url ?? '(none)'} → ${input.url ?? '(none)'}`,
          hasChanges && toggles && (input.completed ? 'Marks it completed' : 'Reopens it'),
        ],
      ),
      what: 'Task',
    };
    return plan;
  });

export const planDeleteTask = (
  policy: AgentPolicy,
  directory: Directory,
  input: ToolInput<'delete_task'>,
) =>
  Effect.gen(function* () {
    const { granted, ref, task } = yield* resolveTask(directory, input.ref);
    const { list } = granted;
    const plan: WritePlan<EventMutations> = {
      decision: decideWrite({
        guests: policy.guests,
        level: granted.level,
        providerWritable: isTaskListWritable(list),
        touchesGuests: false,
      }),
      run: Effect.gen(function* () {
        yield* (yield* EventMutations).deleteTask({
          accountId: ref.accountId,
          taskId: ref.taskId,
          taskListId: ref.taskListId,
        });
        return { status: 'done' as const };
      }),
      summary: summarize(titled('Delete', 'task', task.title), [
        listLine(list.title, directory.accountLabel(list.accountId)),
        task.dueDate !== undefined && dueLine(task.dueDate, task.dueTime),
      ]),
      what: 'Task',
    };
    return plan;
  });
