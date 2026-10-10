import type { TaskListInfo } from '@calendar/core';

/** A Tasks-tab filter chip: `id` null is All, else the list's `taskListKey`. */
export interface TaskListChip {
  readonly id: string | null;
  readonly label: string;
}

/** The key the filter compares: list ids are unique only within an account. */
export const taskListKey = (accountId: string, listId: string): string => `${accountId}:${listId}`;

/**
 * The Tasks tab's list filter. A chip per visible list, and only when there
 * are two to choose from: the inbox leaves hidden lists out, so a hidden
 * list's chip would always read "Nothing to do." The selection holds only
 * while its chip is on screen — a list that was hidden, removed or left
 * alone in the row falls back to All, since nothing else could clear it.
 */
export const taskListChips = (
  lists: ReadonlyArray<Pick<TaskListInfo, 'accountId' | 'id' | 'isVisible' | 'title'>>,
  selected: string | null,
): { readonly active: string | null; readonly chips: ReadonlyArray<TaskListChip> } => {
  const visible = lists.filter((list) => list.isVisible);
  const chips: ReadonlyArray<TaskListChip> =
    visible.length > 1
      ? [
          { id: null, label: 'All' },
          ...visible.map((list) => ({
            id: taskListKey(list.accountId, list.id),
            label: list.title,
          })),
        ]
      : [];
  return { active: chips.some((chip) => chip.id === selected) ? selected : null, chips };
};
