import type { CalendarInfo, TaskListInfo, TaskProvider } from '../types.ts';
import { isCalendarWritable } from './writable.ts';

/**
 * What the editor can make: an event on a calendar, a task on a Google
 * Tasks list, or a reminder on an Apple Reminders list. A task and a
 * reminder share the task model (the selected list decides the provider),
 * so the kind is a name for "a to-do on a list of this provider".
 */
export type ItemKind = 'event' | 'reminder' | 'task';
export type TodoKind = Exclude<ItemKind, 'event'>;

/** The kinds in the order the Event | Task | Reminder control shows them. */
export const ITEM_KINDS: ReadonlyArray<ItemKind> = ['event', 'task', 'reminder'];

export const todoKindOf = (provider: TaskProvider): TodoKind =>
  provider === 'apple' ? 'reminder' : 'task';

export const todoProviderOf = (kind: TodoKind): TaskProvider =>
  kind === 'reminder' ? 'apple' : 'google';

export const taskListKeyOf = (list: Pick<TaskListInfo, 'accountId' | 'id'>): string =>
  `${list.accountId}:${list.id}`;

const writableLists = (lists: ReadonlyArray<TaskListInfo>): ReadonlyArray<TaskListInfo> =>
  lists.filter((list) => !list.readOnly);

/** Visible lists before hidden ones, Reminders before Google within each. */
const listRank = (list: TaskListInfo): number =>
  (list.isVisible ? 0 : 2) + (list.provider === 'apple' ? 0 : 1);

/**
 * The kinds a new item can be: only those with somewhere to go. Without
 * a connected Reminders list there is no Reminder; without a Google
 * account with Tasks there is no Task; without a writable calendar there
 * is no Event. The control hides what is not here.
 */
export const availableItemKinds = ({
  calendars,
  taskLists,
}: {
  readonly calendars: ReadonlyArray<CalendarInfo>;
  readonly taskLists: ReadonlyArray<TaskListInfo>;
}): ReadonlyArray<ItemKind> =>
  ITEM_KINDS.filter((kind) =>
    kind === 'event'
      ? calendars.some(isCalendarWritable)
      : writableLists(taskLists).some((list) => list.provider === todoProviderOf(kind)),
  );

/**
 * Where a "+" falls back when the kind it would open is not available:
 * the calendar's "+" wants an event, the Tasks tab's a reminder and then
 * a task. The wanted kind is returned when nothing is available at all:
 * the editor then says on Save what is missing.
 */
const FALLBACKS: Record<ItemKind, ReadonlyArray<ItemKind>> = {
  event: ['event', 'task', 'reminder'],
  reminder: ['reminder', 'task', 'event'],
  task: ['task', 'reminder', 'event'],
};
export const resolveItemKind = (wanted: ItemKind, available: ReadonlyArray<ItemKind>): ItemKind =>
  FALLBACKS[wanted].find((kind) => available.includes(kind)) ?? wanted;

/**
 * The list a new to-do opens in. The list the user is looking at wins
 * (a Tasks tab filter, `accountId:listId`), then the list the last one
 * was created in, then a Reminders list over a Google one, visible lists
 * before hidden ones. `kind` narrows the choice to that provider's lists
 * (the Task | Reminder switch). Read-only lists are never a target.
 */
export const defaultTodoList = (
  lists: ReadonlyArray<TaskListInfo>,
  {
    filter,
    kind,
    lastUsedKey,
  }: {
    readonly filter?: string | null | undefined;
    readonly kind?: TodoKind | undefined;
    readonly lastUsedKey?: string | null | undefined;
  } = {},
): TaskListInfo | undefined => {
  const candidates = writableLists(lists).filter(
    (list) => kind === undefined || list.provider === todoProviderOf(kind),
  );
  const byKey = (key: string | null | undefined) =>
    key ? candidates.find((list) => taskListKeyOf(list) === key) : undefined;
  return (
    byKey(filter) ??
    byKey(lastUsedKey) ??
    [...candidates].sort((a, b) => listRank(a) - listRank(b))[0]
  );
};
