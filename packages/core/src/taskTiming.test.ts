import { describe, expect, it } from 'vitest';
import { layoutDayColumn, timedEventBox } from './layout/dayGrid.ts';
import { Temporal } from './time/temporal.ts';
import { TaskRecord } from './types.ts';
import {
  TIMED_TASK_LAYOUT_MINUTES,
  calendarTaskKey,
  dropTaskChanges,
  isOverdue,
  moveTimedTask,
  partitionCalendarTasks,
  timedTaskSlot,
} from './taskTiming.ts';

const task = (overrides: Partial<TaskRecord> = {}) =>
  new TaskRecord({
    accountId: 'account-a',
    dueDate: '2026-03-28',
    id: 'task-a',
    listId: 'list-a',
    provider: 'apple',
    status: 'needsAction',
    title: 'Call mom',
    updatedAt: 1,
    ...overrides,
  });

describe('partitionCalendarTasks', () => {
  it('keeps only date-and-time tasks in the timed collection', () => {
    const dateOnly = task({ id: 'date-only' });
    const timed = task({ dueTime: '09:00', id: 'timed' });
    const undated = task({ dueDate: undefined, id: 'undated' });

    expect(partitionCalendarTasks([dateOnly, timed, undated])).toEqual({
      allDay: [dateOnly],
      overdue: [],
      timed: [timed],
    });
  });

  it('moves open tasks due before today into the overdue set, timed or not', () => {
    const pastTimed = task({ dueDate: '2026-03-20', dueTime: '09:00', id: 'past-timed' });
    const pastDateOnly = task({ dueDate: '2026-03-27', id: 'past' });
    const todayTask = task({ id: 'today' });
    const done = task({ dueDate: '2026-03-01', id: 'done', status: 'completed' });

    expect(
      partitionCalendarTasks([todayTask, pastDateOnly, pastTimed, done], '2026-03-28'),
    ).toEqual({
      allDay: [todayTask, done],
      overdue: [pastTimed, pastDateOnly],
      timed: [],
    });
  });

  it('sorts overdue tasks by due date, time and title', () => {
    const b = task({ dueDate: '2026-03-27', id: 'b', title: 'Beta' });
    const a = task({ dueDate: '2026-03-27', id: 'a', title: 'Alpha' });
    const early = task({ dueDate: '2026-03-27', dueTime: '08:00', id: 'early', title: 'Zulu' });
    const older = task({ dueDate: '2026-03-01', id: 'older', title: 'Yankee' });

    expect(
      partitionCalendarTasks([b, a, early, older], '2026-03-28').overdue.map((t) => t.id),
    ).toEqual(['older', 'a', 'b', 'early']);
  });

  it('de-duplicates a task the range and overdue queries both returned', () => {
    const past = task({ dueDate: '2026-03-27', id: 'past' });
    const partition = partitionCalendarTasks([past, past, task()], '2026-03-28');
    expect(partition.overdue).toEqual([past]);
    expect(partition.allDay).toHaveLength(1);
  });
});

describe('isOverdue', () => {
  it('is true only for an open task with a due day before today', () => {
    expect(isOverdue(task({ dueDate: '2026-03-27' }), '2026-03-28')).toBe(true);
    expect(isOverdue(task({ dueDate: '2026-03-28' }), '2026-03-28')).toBe(false);
    expect(isOverdue(task({ dueDate: '2026-03-27', status: 'completed' }), '2026-03-28')).toBe(
      false,
    );
    expect(isOverdue(task({ dueDate: undefined }), '2026-03-28')).toBe(false);
  });
});

describe('calendarTaskKey', () => {
  it('distinguishes identical list and task ids in different accounts', () => {
    expect(calendarTaskKey(task())).not.toBe(calendarTaskKey(task({ accountId: 'account-b' })));
  });
});

describe('timedTaskSlot', () => {
  it('projects a timed task into a compact wall-clock interval', () => {
    expect(timedTaskSlot(task({ dueTime: '09:15' }))).toEqual({
      endMinute: 9 * 60 + 45,
      startMinute: 9 * 60 + 15,
    });
  });

  it('returns no slot for a date-only task', () => {
    expect(timedTaskSlot(task())).toBeUndefined();
  });

  it('keeps a late-night reminder in its due-day layout window', () => {
    expect(timedTaskSlot(task({ dueTime: '23:59' }))).toEqual({
      endMinute: 24 * 60,
      startMinute: 23 * 60 + 30,
    });
  });

  it('draws a reminder inside the spring-forward gap at its stored time', () => {
    // 02:15 does not exist in Vienna on 2026-03-29; resolving it through the
    // zone would draw it at 03:15 under a label that says 2:15 AM.
    expect(timedTaskSlot(task({ dueDate: '2026-03-29', dueTime: '02:15' }))?.startMinute).toBe(
      2 * 60 + 15,
    );
  });

  it.each(['2026-03-29', '2026-10-25'])(
    'lines a reminder up with an event at the same time on %s',
    (dueDate) => {
      const timeZone = 'Europe/Vienna';
      const timed = task({ dueDate, dueTime: '09:15' });
      const epoch = (time: string) =>
        Temporal.PlainDateTime.from(`${dueDate}T${time}`).toZonedDateTime(timeZone)
          .epochMilliseconds;
      const placed = layoutDayColumn([
        timedEventBox(
          { endUtc: epoch('10:15'), startUtc: epoch('09:15') },
          'event',
          Temporal.PlainDate.from(dueDate),
          timeZone,
        ),
        { ...timedTaskSlot(timed)!, id: calendarTaskKey(timed) },
      ]);

      expect(placed).toHaveLength(2);
      for (const box of placed) {
        expect(box.top).toBeCloseTo((9 * 60 + 15) / (24 * 60));
      }
      expect(placed.find((box) => box.id === calendarTaskKey(timed))?.height).toBeCloseTo(
        TIMED_TASK_LAYOUT_MINUTES / (24 * 60),
      );
    },
  );

  it('shares overlap columns with ordinary timed events', () => {
    const timed = task({ dueTime: '09:15' });
    const placed = layoutDayColumn([
      { endMinute: 10 * 60, id: 'event', startMinute: 9 * 60 },
      { ...timedTaskSlot(timed)!, id: calendarTaskKey(timed) },
    ]);

    expect(placed).toHaveLength(2);
    expect(placed.every((box) => box.width === 0.5)).toBe(true);
  });
});

describe('moveTimedTask', () => {
  it('returns no change for an incomplete task', () => {
    expect(moveTimedTask(task(), 15)).toBeUndefined();
    expect(moveTimedTask(task({ dueDate: undefined, dueTime: '09:00' }), 15)).toBeUndefined();
  });

  it('snaps moves and rolls across midnight', () => {
    expect(moveTimedTask(task({ dueTime: '23:15' }), 44)).toEqual({
      dueDate: '2026-03-29',
      dueTime: '00:00',
    });
  });

  it('preserves wall-clock time across a daylight-saving transition', () => {
    expect(moveTimedTask(task({ dueTime: '09:00' }), 0, 1)).toEqual({
      dueDate: '2026-03-29',
    });
  });

  it('returns only the changed time for a move within the day', () => {
    expect(moveTimedTask(task({ dueTime: '09:00' }), 22)).toEqual({
      dueTime: '09:15',
    });
  });

  it.each([0, 7, -7])('returns no change when a %s-minute move snaps to zero', (minutes) => {
    expect(moveTimedTask(task({ dueTime: '09:00' }), minutes)).toBeUndefined();
  });

  it.each(['2026-03-29', '2026-10-25'])(
    'adds wall-clock minutes across the DST transition on %s',
    (dueDate) => {
      expect(moveTimedTask(task({ dueDate, dueTime: '01:45' }), 90)).toEqual({
        dueTime: '03:15',
      });
    },
  );

  it('moves a near-midnight reminder from where its block is drawn', () => {
    // 23:50 is drawn at 23:30 so the block stays on its day; dragging it up
    // half an hour must land on 23:00, where it was dropped.
    expect(moveTimedTask(task({ dueTime: '23:50' }), -30)).toEqual({ dueTime: '23:00' });
    expect(moveTimedTask(task({ dueTime: '23:50' }), 30)).toEqual({
      dueDate: '2026-03-29',
      dueTime: '00:00',
    });
  });

  it('keeps the stored time on a day-only move', () => {
    expect(moveTimedTask(task({ dueTime: '23:50' }), 0, 1)).toEqual({ dueDate: '2026-03-29' });
  });

  it('never rewrites a stored time that falls in the spring-forward gap', () => {
    expect(moveTimedTask(task({ dueDate: '2026-03-29', dueTime: '02:15' }), 15)).toEqual({
      dueTime: '02:30',
    });
    expect(moveTimedTask(task({ dueDate: '2026-03-29', dueTime: '02:15' }), 0, 1)).toEqual({
      dueDate: '2026-03-30',
    });
  });

  it('lands on the dropped wall-clock time inside the spring-forward gap', () => {
    // Reminders store date components, not instants: the grid draws 02:15
    // where it was dropped and EventKit keeps it as-is.
    expect(moveTimedTask(task({ dueTime: '01:45' }), 30, 1)).toEqual({
      dueDate: '2026-03-29',
      dueTime: '02:15',
    });
  });
});

const grid = (dueDate: string, minute: number) => ({ dueDate, kind: 'timed' as const, minute });
const lane = (dueDate: string) => ({ dueDate, kind: 'allDay' as const });

describe('dropTaskChanges', () => {
  it('gives a reminder dropped in the grid that day and time', () => {
    expect(dropTaskChanges(task(), grid('2026-03-30', 10 * 60 + 15))).toEqual({
      changes: { dueDate: '2026-03-30', dueTime: '10:15' },
    });
  });

  it('sets only the time when the reminder stays on its day', () => {
    expect(dropTaskChanges(task(), grid('2026-03-28', 9 * 60))).toEqual({
      changes: { dueTime: '09:00' },
    });
    expect(dropTaskChanges(task({ dueTime: '09:00' }), grid('2026-03-28', 9 * 60))).toBeUndefined();
  });

  it('refuses a grid drop for a date-only Google task instead of moving its day', () => {
    expect(dropTaskChanges(task({ provider: 'google' }), grid('2026-03-30', 9 * 60))).toEqual({
      unsupported: 'dueTime',
    });
  });

  it('clears the time of a timed reminder dropped in the lane', () => {
    expect(dropTaskChanges(task({ dueTime: '14:00' }), lane('2026-03-28'))).toEqual({
      changes: { dueTime: null },
    });
    expect(dropTaskChanges(task({ dueTime: '14:00' }), lane('2026-03-29'))).toEqual({
      changes: { dueDate: '2026-03-29', dueTime: null },
    });
  });

  it('moves the day of a date-only task dropped elsewhere in the lane, for either provider', () => {
    expect(dropTaskChanges(task(), lane('2026-03-29'))).toEqual({
      changes: { dueDate: '2026-03-29' },
    });
    expect(dropTaskChanges(task({ provider: 'google' }), lane('2026-03-29'))).toEqual({
      changes: { dueDate: '2026-03-29' },
    });
    expect(dropTaskChanges(task(), lane('2026-03-28'))).toBeUndefined();
  });

  it('re-dates an overdue reminder dragged from today, clearing a stale time', () => {
    const overdue = task({ dueDate: '2026-03-20', dueTime: '09:00' });
    expect(dropTaskChanges(overdue, lane('2026-03-28'))).toEqual({
      changes: { dueDate: '2026-03-28', dueTime: null },
    });
    expect(dropTaskChanges(overdue, grid('2026-03-28', 11 * 60))).toEqual({
      changes: { dueDate: '2026-03-28', dueTime: '11:00' },
    });
  });
});
