import { compareTaskPosition, type TaskTreeNode } from './taskInbox.ts';
import { TaskRecord } from './types.ts';

/**
 * The characters of a provisional position, in code-unit order: Google's
 * digits and "-" below them, so a key always fits below Google's lowest
 * ("-4" < "000…0") and between a key and that key plus "0".
 */
const ALPHABET = '-0123456789';

/**
 * A `position` strictly between two others (absent: no bound on that
 * side), for a task placed before Google numbers it. Google's positions
 * are 20-digit ordinals ("…01", "…02") that sort code unit by code unit;
 * this one sorts between its bounds ("…014"), so it can be a bound itself
 * the next time. It never ends in "-": with that, every pair of distinct
 * keys has room between them. Bounds in the wrong order give the lower
 * one back.
 */
export const positionBetween = (before: string | undefined, after: string | undefined): string => {
  const low = before ?? '';
  const high = after ?? '';
  let key = '';
  let aboveLow = false;
  let belowHigh = after === undefined;
  for (let index = 0; index <= low.length + high.length; index += 1) {
    // -1 and ALPHABET.length: that bound no longer limits this character.
    const lo: number = aboveLow || index >= low.length ? -1 : ALPHABET.indexOf(low.charAt(index));
    const hi: number = belowHigh
      ? ALPHABET.length
      : index >= high.length
        ? -1
        : ALPHABET.indexOf(high.charAt(index));
    // Never the lowest character last: nothing would fit right below it.
    const least = Math.max(lo + 1, 1);
    if (least < hi) {
      return key + ALPHABET.charAt(Math.min(Math.max(Math.ceil((lo + hi) / 2), least), hi - 1));
    }
    // No room for a last character here: keep level with the lower bound
    // (or take the lowest) and go on.
    const at = Math.max(lo, 0);
    if (at > hi) {
      break;
    }
    key += ALPHABET.charAt(at);
    aboveLow = aboveLow || at > lo;
    belowHigh = belowHigh || at < hi;
  }
  return low;
};

/**
 * Where `task` sorts among `siblings` (its new siblings, itself left
 * out) when it goes right after `previousId` — first without one — until
 * the list's real order comes back from Google. A sibling Google has not
 * numbered yet (its create is queued) sorts last; a previous like that
 * puts the task after the last one Google has numbered.
 */
export const provisionalPosition = (
  siblings: ReadonlyArray<TaskRecord>,
  previousId: string | undefined,
): string => {
  const numbered = siblings
    .filter((sibling) => sibling.position !== undefined)
    .sort(compareTaskPosition);
  if (previousId === undefined) {
    return positionBetween(undefined, numbered[0]?.position);
  }
  const at = numbered.findIndex((sibling) => sibling.id === previousId);
  return at < 0
    ? positionBetween(numbered.at(-1)?.position, undefined)
    : positionBetween(numbered[at]?.position, numbered[at + 1]?.position);
};

/** The task with the parent and position `place` holds (absent there: none). */
export const placedTask = (
  task: TaskRecord,
  place: Pick<TaskRecord, 'parentId' | 'position'>,
): TaskRecord => {
  const { parentId: _parentId, position: _position, ...rest } = task;
  return new TaskRecord({
    ...rest,
    ...(place.parentId === undefined ? {} : { parentId: place.parentId }),
    ...(place.position === undefined ? {} : { position: place.position }),
  });
};

/**
 * A task's place in its list, as `tasks.move` takes it: under `parentId`
 * (absent: a task of its own) right after `previousId` (absent: first
 * among those siblings).
 */
export interface TaskPlacement {
  readonly parentId?: string;
  readonly previousId?: string;
}

/** One drawn row of an inbox section: depth 1 is a subtask under its parent (`group`). */
export interface TaskInboxRow {
  readonly depth: 0 | 1;
  /** The top-level row of its group: itself at depth 0, its parent at depth 1. */
  readonly group: TaskRecord;
  readonly task: TaskRecord;
}

/** A section's tree as it is drawn, top to bottom. */
export const flattenTaskTree = (tree: ReadonlyArray<TaskTreeNode>): ReadonlyArray<TaskInboxRow> =>
  tree.flatMap(({ subtasks, task }) => [
    { depth: 0 as const, group: task, task },
    ...subtasks.map((subtask) => ({ depth: 1 as const, group: task, task: subtask })),
  ]);

/**
 * Whether a row can be placed at all: a Google task Google already has.
 * Reminders have no order or subtasks through EventKit, and a task whose
 * create is still queued has no id Google could place.
 */
export const canPlaceTask = (task: TaskRecord): boolean =>
  task.provider === 'google' && !task.id.startsWith('local-');

const sameTask = (a: TaskRecord, b: TaskRecord): boolean =>
  a.accountId === b.accountId && a.listId === b.listId && a.id === b.id;

/** A drop that changes the task's place: the gap it lands in and where that puts it. */
export interface TaskPlacementDrop {
  readonly depth: 0 | 1;
  readonly placement: TaskPlacement;
  /** The gap, counted in the section's rows without the dragged one: `rows[slot - 1]` is above it. */
  readonly slot: number;
}

/**
 * What dropping `task` into gap `slot` of its section, at `depth`, does —
 * or null when that changes nothing or is not allowed.
 *
 * Depth 1 makes it a subtask of the group above the gap, right after the
 * row above (first when that row is the parent itself): reordering
 * subtasks, nesting a task, moving a subtask to another parent. The parent
 * must be a top-level Google task of the same list — not a subtask drawn
 * at the top because its parent is in another section — and a row drawn
 * with subtasks stays where it is (Google Tasks nests one level deep).
 *
 * Depth 0 takes a subtask drawn under its parent out of it, right after
 * the parent on Google. Top-level rows keep the section's own order (by
 * day, then title — rows of several lists and providers, whose positions
 * do not compare), so a top-level row dropped at depth 0 does not move.
 */
export const taskDropAt = (
  rows: ReadonlyArray<TaskInboxRow>,
  task: TaskRecord,
  slot: number,
  depth: 0 | 1,
): TaskPlacementDrop | null => {
  const at = rows.findIndex((row) => sameTask(row.task, task));
  const own = rows[at];
  if (own === undefined || !canPlaceTask(task)) {
    return null;
  }
  if (own.depth === 0 && rows[at + 1]?.depth === 1) {
    return null;
  }
  const others = rows.filter((_, index) => index !== at);
  const gap = Math.min(Math.max(slot, 0), others.length);
  if (depth === 0) {
    return own.depth === 1 ? { depth, placement: { previousId: own.group.id }, slot: gap } : null;
  }
  const above = others[gap - 1];
  const parent = above?.group;
  if (
    above === undefined ||
    parent === undefined ||
    parent.accountId !== task.accountId ||
    parent.listId !== task.listId ||
    !canPlaceTask(parent) ||
    // Drawn at the top only because its own parent is in another section.
    parent.parentId !== undefined ||
    // Where it already is.
    (own.depth === 1 && gap === at)
  ) {
    return null;
  }
  return {
    depth,
    placement: { parentId: parent.id, ...(above.depth === 1 ? { previousId: above.task.id } : {}) },
    slot: gap,
  };
};

/** Indent: the row becomes a subtask of the group above it, right where it is drawn. */
export const indentTaskDrop = (
  rows: ReadonlyArray<TaskInboxRow>,
  task: TaskRecord,
): TaskPlacementDrop | null => {
  const at = rows.findIndex((row) => sameTask(row.task, task));
  return at < 0 || rows[at]?.depth === 1 ? null : taskDropAt(rows, task, at, 1);
};

/** Outdent: a subtask drawn under its parent becomes a task of its own, right after the parent. */
export const outdentTaskDrop = (
  rows: ReadonlyArray<TaskInboxRow>,
  task: TaskRecord,
): TaskPlacementDrop | null => {
  const at = rows.findIndex((row) => sameTask(row.task, task));
  return at < 0 ? null : taskDropAt(rows, task, at, 0);
};
