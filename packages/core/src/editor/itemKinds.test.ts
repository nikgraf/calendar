import { describe, expect, it } from 'vite-plus/test';
import { CalendarInfo, TaskListInfo } from '../types.ts';
import {
  availableItemKinds,
  defaultTodoList,
  resolveItemKind,
  taskListKeyOf,
  todoKindOf,
} from './itemKinds.ts';

const list = (accountId: string, id: string, overrides: Partial<TaskListInfo> = {}) =>
  new TaskListInfo({
    accountId,
    id,
    isVisible: true,
    provider: accountId === 'apple-reminders' ? 'apple' : 'google',
    title: id,
    ...overrides,
  });

const calendar = (id: string, accessRole: CalendarInfo['accessRole']) =>
  new CalendarInfo({
    accessRole,
    accountId: 'google-a',
    colorHex: '#ff0000',
    id,
    isPrimary: false,
    isVisible: true,
    provider: 'google',
    summary: id,
    timeZone: 'UTC',
  });

const lists = [
  list('apple-reminders', 'reminders'),
  list('google-a', 'inbox'),
  list('google-b', 'inbox'),
  list('apple-reminders', 'shared', { readOnly: true }),
  list('google-a', 'hidden', { isVisible: false }),
];
const keyOf = (target: TaskListInfo | undefined) => target && taskListKeyOf(target);

describe('availableItemKinds', () => {
  it('offers a kind only when something can hold it', () => {
    expect(availableItemKinds({ calendars: [calendar('cal', 'owner')], taskLists: lists })).toEqual(
      ['event', 'task', 'reminder'],
    );
    expect(availableItemKinds({ calendars: [calendar('cal', 'reader')], taskLists: [] })).toEqual(
      [],
    );
    expect(
      availableItemKinds({ calendars: [], taskLists: [list('apple-reminders', 'reminders')] }),
    ).toEqual(['reminder']);
    // A read-only Reminders list is no home for a new reminder.
    expect(
      availableItemKinds({
        calendars: [],
        taskLists: [list('apple-reminders', 'shared', { readOnly: true }), list('google-a', 'x')],
      }),
    ).toEqual(['task']);
  });
});

describe('resolveItemKind', () => {
  it('keeps an available kind and falls back in the order of the "+" that asked', () => {
    expect(resolveItemKind('event', ['event', 'task'])).toBe('event');
    expect(resolveItemKind('reminder', ['event', 'task'])).toBe('task');
    expect(resolveItemKind('reminder', ['event'])).toBe('event');
    expect(resolveItemKind('event', ['reminder'])).toBe('reminder');
    expect(resolveItemKind('task', ['event', 'reminder'])).toBe('reminder');
  });

  it('answers the wanted kind when nothing is available', () => {
    expect(resolveItemKind('reminder', [])).toBe('reminder');
  });
});

describe('defaultTodoList', () => {
  it('prefers a Reminders list, visible ones first, when nothing else says', () => {
    expect(keyOf(defaultTodoList(lists))).toBe('apple-reminders:reminders');
    expect(keyOf(defaultTodoList(lists.slice(1)))).toBe('google-a:inbox');
    // Hidden lists come after every visible one, whatever the provider.
    expect(
      keyOf(
        defaultTodoList([
          list('apple-reminders', 'hidden', { isVisible: false }),
          list('google-a', 'inbox'),
        ]),
      ),
    ).toBe('google-a:inbox');
  });

  it('takes the filtered list, told apart by account, then the last-used one', () => {
    expect(keyOf(defaultTodoList(lists, { filter: 'google-b:inbox' }))).toBe('google-b:inbox');
    expect(
      keyOf(defaultTodoList(lists, { filter: 'google-b:inbox', lastUsedKey: 'google-a:inbox' })),
    ).toBe('google-b:inbox');
    expect(keyOf(defaultTodoList(lists, { lastUsedKey: 'google-a:inbox' }))).toBe('google-a:inbox');
  });

  it('ignores a filter or memory of a read-only or vanished list', () => {
    for (const key of ['apple-reminders:shared', 'google-c:inbox']) {
      expect(keyOf(defaultTodoList(lists, { filter: key }))).toBe('apple-reminders:reminders');
      expect(keyOf(defaultTodoList(lists, { lastUsedKey: key }))).toBe('apple-reminders:reminders');
    }
    // A hidden list is still a list the user named.
    expect(keyOf(defaultTodoList(lists, { filter: 'google-a:hidden' }))).toBe('google-a:hidden');
  });

  it('narrows to the kind asked for', () => {
    expect(keyOf(defaultTodoList(lists, { kind: 'task' }))).toBe('google-a:inbox');
    expect(keyOf(defaultTodoList(lists, { kind: 'reminder' }))).toBe('apple-reminders:reminders');
    // The memory of a list in the other provider does not pull the kind along.
    expect(
      keyOf(defaultTodoList(lists, { kind: 'task', lastUsedKey: 'apple-reminders:reminders' })),
    ).toBe('google-a:inbox');
    expect(defaultTodoList(lists.slice(1), { kind: 'reminder' })).toBeUndefined();
  });

  it('names the kind of a list', () => {
    expect(todoKindOf('apple')).toBe('reminder');
    expect(todoKindOf('google')).toBe('task');
  });
});
