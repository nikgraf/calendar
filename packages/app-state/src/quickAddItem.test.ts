import { describe, expect, it } from 'vite-plus/test';
import { convertQuickAddItem, type QuickAddItem } from './quickAddItem.ts';

const lunch: QuickAddItem = {
  kind: 'event',
  prefill: {
    date: '2026-10-03',
    endTime: '14:00',
    isAllDay: false,
    location: 'Café Sperl',
    startTime: '13:00',
    title: 'Lunch with Sarah',
  },
};

describe('convertQuickAddItem', () => {
  it('keeps an item that already is the asked kind', () => {
    expect(convertQuickAddItem(lunch, 'event')).toBe(lunch);
  });

  it('turns a timed event into a task due at its start, an all-day one into a task on its day', () => {
    expect(convertQuickAddItem(lunch, 'task')).toEqual({
      kind: 'task',
      prefill: { date: '2026-10-03', time: '13:00', title: 'Lunch with Sarah' },
    });
    const allDay: QuickAddItem = {
      kind: 'event',
      prefill: { ...lunch.prefill, endTime: '01:00', isAllDay: true, startTime: '00:00' },
    };
    expect(convertQuickAddItem(allDay, 'task')).toEqual({
      kind: 'task',
      prefill: { date: '2026-10-03', title: 'Lunch with Sarah' },
    });
  });

  it('turns a task into a one-hour event at its time, or an all-day event without one', () => {
    expect(
      convertQuickAddItem(
        { kind: 'task', prefill: { date: '2026-10-03', time: '09:30', title: 'Call the bank' } },
        'event',
      ),
    ).toEqual({
      kind: 'event',
      prefill: {
        date: '2026-10-03',
        endTime: '10:30',
        isAllDay: false,
        startTime: '09:30',
        title: 'Call the bank',
      },
    });
    expect(
      convertQuickAddItem(
        { kind: 'task', prefill: { date: '2026-10-03', title: 'Buy milk' } },
        'event',
      ),
    ).toEqual({
      kind: 'event',
      prefill: {
        date: '2026-10-03',
        endTime: '01:00',
        isAllDay: true,
        startTime: '00:00',
        title: 'Buy milk',
      },
    });
    // A to-do in the last hour of the day stays on its day.
    expect(
      convertQuickAddItem(
        { kind: 'task', prefill: { date: '2026-10-03', time: '23:30', title: 'Late' } },
        'event',
      ).prefill,
    ).toMatchObject({ endTime: '23:59', startTime: '23:30' });
  });
});
