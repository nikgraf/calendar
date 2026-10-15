import { describe, expect, it } from 'vite-plus/test';
import { groupTaskInbox, nestSubtasks } from './taskInbox.ts';
import { TaskRecord } from './types.ts';

const TODAY = '2026-10-02';
const ZONE = 'Europe/Vienna';

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

describe('groupTaskInbox', () => {
  it('sorts tasks into late, today, no day, later and done today', () => {
    const inbox = groupTaskInbox(
      [
        task('rent', { dueDate: '2026-09-17' }),
        task('invoice', { dueDate: TODAY }),
        task('landlord', { dueDate: TODAY, dueTime: '12:30' }),
        task('hotel'),
        task('gift', { dueDate: '2026-10-03' }),
        task('taxes', { dueDate: '2026-10-20' }),
        task('done-today', {
          completedAt: Date.parse('2026-10-02T08:00:00+02:00'),
          dueDate: TODAY,
          status: 'completed',
        }),
        task('done-late', {
          completedAt: Date.parse('2026-10-02T09:00:00+02:00'),
          dueDate: '2026-09-30',
          status: 'completed',
        }),
        task('done-yesterday', {
          completedAt: Date.parse('2026-10-01T09:00:00+02:00'),
          dueDate: '2026-10-01',
          status: 'completed',
        }),
        // Finished early: done today although due tomorrow.
        task('done-early', {
          completedAt: Date.parse('2026-10-02T07:00:00+02:00'),
          dueDate: '2026-10-03',
          status: 'completed',
        }),
        // Finished yesterday although due today: not today's.
        task('done-ahead', {
          completedAt: Date.parse('2026-10-01T18:00:00+02:00'),
          dueDate: TODAY,
          status: 'completed',
        }),
      ],
      TODAY,
      ZONE,
    );
    expect(inbox.overdue.map((t) => t.id)).toEqual(['rent']);
    // Timed before untimed? No: due day, then time ('' first), then title.
    expect(inbox.today.map((t) => t.id)).toEqual(['invoice', 'landlord']);
    expect(inbox.noDate.map((t) => t.id)).toEqual(['hotel']);
    expect(inbox.upcoming.map((t) => t.id)).toEqual(['gift', 'taxes']);
    // Newest completion first, by the day it was done: yesterday's are not today's.
    expect(inbox.completedToday.map((t) => t.id)).toEqual([
      'done-late',
      'done-today',
      'done-early',
    ]);
  });

  it('drops a task the window and overdue queries both returned', () => {
    const late = task('rent', { dueDate: '2026-09-17' });
    expect(groupTaskInbox([late, late], TODAY, ZONE).overdue).toHaveLength(1);
  });
});

/** A row's id, or `[id, subtask ids]` when it holds subtasks. */
const shape = (tasks: ReadonlyArray<TaskRecord>) =>
  nestSubtasks(tasks).map((node) =>
    node.subtasks.length === 0 ? node.task.id : [node.task.id, node.subtasks.map((t) => t.id)],
  );

describe('nestSubtasks', () => {
  it("draws subtasks under their parent in Google's order, the section's order around them", () => {
    expect(
      shape([
        task('groceries', { title: 'Buy groceries' }),
        // Title order would put "Apply" first; Google's position wins.
        task('visa', {
          parentId: 'trip',
          position: '00000000000000000002',
          title: 'Apply for visa',
        }),
        task('rent', { title: 'Pay rent' }),
        task('trip', { title: 'Plan trip' }),
        task('passport', {
          parentId: 'trip',
          position: '00000000000000000001',
          title: 'Renew passport',
        }),
        task('milk', { parentId: 'groceries', position: '00000000000000000000', title: 'Milk' }),
      ]),
    ).toEqual([['groceries', ['milk']], 'rent', ['trip', ['passport', 'visa']]]);
  });

  it('puts a subtask without a position yet after its positioned siblings', () => {
    expect(
      shape([
        task('trip'),
        task('fresh', { parentId: 'trip', title: 'A fresh one' }),
        task('passport', { parentId: 'trip', position: '00000000000000000005' }),
      ]),
    ).toEqual([['trip', ['passport', 'fresh']]]);
  });

  it('keeps a subtask whose parent is elsewhere as a row of its own section', () => {
    // The parent is due another day, done, or filtered out: not in this section.
    expect(shape([task('passport', { parentId: 'trip' }), task('rent')])).toEqual([
      'passport',
      'rent',
    ]);
  });

  it('only nests under the same list and account', () => {
    expect(
      shape([
        task('trip'),
        task('other-list', { listId: 'errands', parentId: 'trip' }),
        task('other-account', { accountId: 'acc-2', parentId: 'trip' }),
      ]),
    ).toEqual(['trip', 'other-list', 'other-account']);
  });

  it('nests one level deep and survives a cycle', () => {
    expect(
      shape([
        task('trip'),
        task('passport', { parentId: 'trip', position: '1' }),
        // Google allows no grandchild; one stays at the top.
        task('photo', { parentId: 'passport' }),
        task('a', { parentId: 'b' }),
        task('b', { parentId: 'a' }),
        task('self', { parentId: 'self' }),
      ]),
    ).toEqual([['trip', ['passport']], 'photo', 'a', 'b', 'self']);
  });

  it('leaves Reminders, which have no parents, as they were', () => {
    const reminders = [task('call', { provider: 'apple' }), task('water', { provider: 'apple' })];
    expect(shape(reminders)).toEqual(['call', 'water']);
  });
});
