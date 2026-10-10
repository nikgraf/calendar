import { describe, expect, it } from 'vite-plus/test';
import { groupTaskInbox } from './taskInbox.ts';
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
