import { describe, expect, it } from 'vite-plus/test';
import { compareTaskPosition, nestSubtasks } from './taskInbox.ts';
import {
  flattenTaskTree,
  indentTaskDrop,
  outdentTaskDrop,
  positionBetween,
  provisionalPosition,
  taskDropAt,
} from './taskOrder.ts';
import { TaskRecord } from './types.ts';

const task = (id: string, overrides: Partial<TaskRecord> = {}) =>
  new TaskRecord({
    accountId: 'acc',
    id,
    listId: 'list',
    provider: 'google',
    status: 'needsAction',
    title: id,
    updatedAt: 1,
    ...overrides,
  });

/** Google's 20-digit ordinal for index `n`. */
const at = (n: number) => String(n).padStart(20, '0');

describe('positionBetween', () => {
  it('sorts between two of Google’s positions, and before or after one', () => {
    for (const [before, after] of [
      [at(1), at(2)],
      [at(9), at(10)],
      [at(0), undefined],
      [undefined, at(3)],
      [undefined, at(0)],
      [undefined, undefined],
    ] as const) {
      const key = positionBetween(before, after);
      expect(key > (before ?? '')).toBe(true);
      if (after !== undefined) {
        expect(key < after).toBe(true);
      }
    }
    expect(positionBetween(at(1), at(2))).toBe(`${at(1)}4`);
  });

  it('keeps finding room as drops pile up in one gap', () => {
    // Repeatedly drop right after the first row, then right before the
    // second: each key must sort strictly inside its gap.
    let low = at(4);
    let high = at(5);
    for (let round = 0; round < 40; round += 1) {
      const key = positionBetween(low, high);
      expect(key > low && key < high).toBe(true);
      if (round % 2 === 0) {
        high = key;
      } else {
        low = key;
      }
    }
    // Always first, in front of whatever was first before — and each time
    // with room left right behind it.
    let first = at(0);
    for (let round = 0; round < 15; round += 1) {
      const key = positionBetween(undefined, first);
      expect(key < first).toBe(true);
      const behind = positionBetween(key, first);
      expect(behind > key && behind < first).toBe(true);
      first = key;
    }
  });

  it('fits below Google’s lowest and between a key and that key plus "0"', () => {
    expect(positionBetween(undefined, at(0)) < at(0)).toBe(true);
    expect(positionBetween('12', '120')).toBe('12-4');
    // Bounds in the wrong order: the lower one back.
    expect(positionBetween(at(3), at(1))).toBe(at(3));
  });
});

describe('provisionalPosition', () => {
  const siblings = [
    task('c', { position: at(2) }),
    task('a', { position: at(0) }),
    task('b', { position: at(1) }),
    // Created here, not numbered by Google yet: drawn last.
    task('local-new'),
  ];
  const placedAfter = (previousId: string | undefined) => {
    const moved = task('moved', { position: provisionalPosition(siblings, previousId) });
    return [...siblings, moved].sort(compareTaskPosition).map((row) => row.id);
  };

  it('sorts the task right where it was dropped', () => {
    expect(placedAfter(undefined)).toEqual(['moved', 'a', 'b', 'c', 'local-new']);
    expect(placedAfter('a')).toEqual(['a', 'moved', 'b', 'c', 'local-new']);
    expect(placedAfter('c')).toEqual(['a', 'b', 'c', 'moved', 'local-new']);
    // After a sibling Google has not numbered: after the last it has.
    expect(placedAfter('local-new')).toEqual(['a', 'b', 'c', 'moved', 'local-new']);
    expect(provisionalPosition([], undefined)).toBe('4');
  });
});

describe('taskDropAt', () => {
  // Plan trip ▸ Passport, Visa · Rent · Party ▸ Cake · a reminder · a row in another list.
  const trip = task('trip');
  const passport = task('passport', { parentId: 'trip', position: at(0) });
  const visa = task('visa', { parentId: 'trip', position: at(1) });
  const rent = task('rent');
  const party = task('party');
  const cake = task('cake', { parentId: 'party', position: at(0) });
  const reminder = task('rem', { listId: 'ek', provider: 'apple' });
  const errand = task('errand', { listId: 'errands' });
  const rows = flattenTaskTree(
    nestSubtasks([trip, passport, visa, rent, party, cake, reminder, errand]),
  );

  it('draws the section as rows, subtasks one level in', () => {
    expect(rows.map((row) => `${'  '.repeat(row.depth)}${row.task.id}`)).toEqual([
      'trip',
      '  passport',
      '  visa',
      'rent',
      'party',
      '  cake',
      'rem',
      'errand',
    ]);
  });

  it('reorders a subtask among its siblings', () => {
    // Visa dropped between Trip and Passport: first under Trip.
    expect(taskDropAt(rows, visa, 1, 1)).toEqual({
      depth: 1,
      placement: { parentId: 'trip' },
      slot: 1,
    });
    // Passport dropped below Visa.
    expect(taskDropAt(rows, passport, 2, 1)?.placement).toEqual({
      parentId: 'trip',
      previousId: 'visa',
    });
    // Back where it was: nothing to do.
    expect(taskDropAt(rows, passport, 1, 1)).toBeNull();
  });

  it('nests a task under the group above the gap, and moves a subtask to another parent', () => {
    // Rent indented in place: under Trip, after Visa.
    expect(taskDropAt(rows, rent, 3, 1)?.placement).toEqual({
      parentId: 'trip',
      previousId: 'visa',
    });
    // Visa dropped under Party, after Cake.
    expect(taskDropAt(rows, visa, 5, 1)?.placement).toEqual({
      parentId: 'party',
      previousId: 'cake',
    });
  });

  it('takes a subtask out of its parent at depth 0, right after the parent', () => {
    expect(taskDropAt(rows, visa, 6, 0)).toEqual({
      depth: 0,
      placement: { previousId: 'trip' },
      slot: 6,
    });
    // A top-level row keeps the section's order: dropping it elsewhere at the top does nothing.
    expect(taskDropAt(rows, rent, 0, 0)).toBeNull();
  });

  it('keeps the hierarchy one level deep and inside one Google list', () => {
    // Trip has subtasks: it stays where it is.
    expect(taskDropAt(rows, trip, 4, 1)).toBeNull();
    // Under the reminder, or a row of another list: no.
    expect(taskDropAt(rows, errand, 7, 1)).toBeNull();
    expect(taskDropAt(rows, reminder, 6, 1)).toBeNull();
    // Nothing above the first gap to nest under.
    expect(taskDropAt(rows, rent, 0, 1)).toBeNull();
    // A task Google does not have yet cannot be placed, nor be a parent.
    const fresh = task('local-1');
    const withFresh = flattenTaskTree(nestSubtasks([fresh, rent]));
    expect(taskDropAt(withFresh, rent, 1, 1)).toBeNull();
    expect(taskDropAt(withFresh, fresh, 1, 1)).toBeNull();
  });

  it('never nests under a subtask drawn at the top because its parent is elsewhere', () => {
    // Pack's parent is in another section: Pack is drawn as a top-level row.
    const orphan = flattenTaskTree(nestSubtasks([passport, rent]));
    expect(orphan.map((row) => row.depth)).toEqual([0, 0]);
    expect(taskDropAt(orphan, rent, 1, 1)).toBeNull();
    expect(indentTaskDrop(orphan, rent)).toBeNull();
  });

  it('indents and outdents in place', () => {
    expect(indentTaskDrop(rows, rent)?.placement).toEqual({
      parentId: 'trip',
      previousId: 'visa',
    });
    expect(indentTaskDrop(rows, party)?.placement).toBeUndefined();
    expect(indentTaskDrop(rows, passport)).toBeNull();
    expect(outdentTaskDrop(rows, passport)?.placement).toEqual({ previousId: 'trip' });
    expect(outdentTaskDrop(rows, rent)).toBeNull();
    // Under a top-level row without subtasks: its first subtask.
    const flat = flattenTaskTree(nestSubtasks([rent, errand, task('gift')]));
    expect(indentTaskDrop(flat, task('gift'))?.placement).toBeUndefined();
    expect(indentTaskDrop(flat, errand)).toBeNull();
    const sameList = flattenTaskTree(nestSubtasks([rent, task('gift')]));
    expect(indentTaskDrop(sameList, task('gift'))?.placement).toEqual({ parentId: 'rent' });
  });
});
