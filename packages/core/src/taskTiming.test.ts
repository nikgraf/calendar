import { describe, expect, it } from 'vitest';
import { layoutDayColumn } from './layout/dayGrid.ts';
import { dayRange } from './time/ranges.ts';
import { Temporal } from './time/temporal.ts';
import { TaskRecord } from './types.ts';
import {
  TIMED_TASK_LAYOUT_MINUTES,
  calendarTaskKey,
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
      timed: [timed],
    });
  });
});

describe('calendarTaskKey', () => {
  it('distinguishes identical list and task ids in different accounts', () => {
    expect(calendarTaskKey(task())).not.toBe(calendarTaskKey(task({ accountId: 'account-b' })));
  });
});

describe('timedTaskSlot', () => {
  it('projects a timed task into a compact layout interval', () => {
    const slot = timedTaskSlot(task({ dueTime: '09:15' }), 'Europe/Vienna');

    expect(slot).toEqual({
      endUtc: Date.parse('2026-03-28T08:45:00Z'),
      layoutEndMinute: 9 * 60 + 45,
      layoutStartMinute: 9 * 60 + 15,
      startUtc: Date.parse('2026-03-28T08:15:00Z'),
    });
  });

  it('returns no slot for a date-only task', () => {
    expect(timedTaskSlot(task(), 'Europe/Vienna')).toBeUndefined();
  });

  it('keeps a late-night reminder in its due-day layout window', () => {
    const slot = timedTaskSlot(task({ dueTime: '23:59' }), 'Europe/Vienna');

    expect(slot?.endUtc).toBe(Date.parse('2026-03-28T23:00:00Z'));
    expect(slot?.layoutEndMinute).toBe(24 * 60);
    expect(slot?.layoutStartMinute).toBe(23 * 60 + 30);
    expect(slot?.startUtc).toBe(Date.parse('2026-03-28T22:30:00Z'));
  });

  it.each([
    ['spring-forward', '2026-03-29', '2026-03-29T07:15:00Z'],
    ['fall-back', '2026-10-25', '2026-10-25T08:15:00Z'],
  ])('keeps the due-time position on a %s day', (_label, dueDate, startIso) => {
    const timed = task({ dueDate, dueTime: '09:15' });
    const slot = timedTaskSlot(timed, 'Europe/Vienna')!;
    const range = dayRange(Temporal.PlainDate.from(dueDate), 'Europe/Vienna');
    const [placed] = layoutDayColumn(
      [{ ...slot, id: calendarTaskKey(timed) }],
      range.startUtc,
      range.endUtc,
    );

    expect(slot.startUtc).toBe(Date.parse(startIso));
    expect(slot.endUtc).toBe(Date.parse(startIso) + TIMED_TASK_LAYOUT_MINUTES * 60 * 1000);
    expect(placed?.top).toBeCloseTo((9 * 60 + 15) / (24 * 60));
    expect(placed?.height).toBeCloseTo(TIMED_TASK_LAYOUT_MINUTES / (24 * 60));
  });

  it('shares overlap columns with ordinary timed events', () => {
    const timed = task({ dueTime: '09:15' });
    const taskSlot = timedTaskSlot(timed, 'Europe/Vienna')!;
    const range = dayRange(Temporal.PlainDate.from(timed.dueDate!), 'Europe/Vienna');
    const placed = layoutDayColumn(
      [
        {
          endUtc: Date.parse('2026-03-28T09:00:00Z'),
          id: 'event',
          startUtc: Date.parse('2026-03-28T08:00:00Z'),
        },
        { ...taskSlot, id: calendarTaskKey(timed) },
      ],
      range.startUtc,
      range.endUtc,
    );

    expect(placed).toHaveLength(2);
    expect(placed.every((box) => box.width === 0.5)).toBe(true);
  });
});

describe('moveTimedTask', () => {
  it('returns no change for an incomplete task', () => {
    expect(moveTimedTask(task(), 'Europe/Vienna', 15)).toBeUndefined();
    expect(
      moveTimedTask(task({ dueDate: undefined, dueTime: '09:00' }), 'Europe/Vienna', 15),
    ).toBeUndefined();
  });

  it('snaps moves and rolls across midnight', () => {
    expect(moveTimedTask(task({ dueTime: '23:45' }), 'Europe/Vienna', 22)).toEqual({
      dueDate: '2026-03-29',
      dueTime: '00:00',
    });
  });

  it('preserves wall-clock time across a daylight-saving transition', () => {
    expect(moveTimedTask(task({ dueTime: '09:00' }), 'Europe/Vienna', 0, 1)).toEqual({
      dueDate: '2026-03-29',
    });
  });

  it('returns only the changed time for a move within the day', () => {
    expect(moveTimedTask(task({ dueTime: '09:00' }), 'Europe/Vienna', 22)).toEqual({
      dueTime: '09:15',
    });
  });

  it.each([0, 7, -7])('returns no change when a %s-minute move snaps to zero', (minutes) => {
    expect(moveTimedTask(task({ dueTime: '09:00' }), 'Europe/Vienna', minutes)).toBeUndefined();
  });

  it.each(['2026-03-29', '2026-10-25'])(
    'adds wall-clock minutes across the DST transition on %s',
    (dueDate) => {
      expect(moveTimedTask(task({ dueDate, dueTime: '01:45' }), 'Europe/Vienna', 90)).toEqual({
        dueTime: '03:15',
      });
    },
  );

  it('normalizes a nonexistent local time across spring-forward', () => {
    expect(moveTimedTask(task({ dueTime: '01:45' }), 'Europe/Vienna', 30, 1)).toEqual({
      dueDate: '2026-03-29',
      dueTime: '03:15',
    });
  });
});
