import { describe, expect, it } from 'vitest';
import { Temporal } from '../time/temporal.ts';
import { EventRecord } from '../types.ts';
import { groupEventsByDay } from './dayGrouping.ts';
import { eventsOnDay } from './dayMembership.ts';

const instant = (iso: string): number => Temporal.Instant.from(iso).epochMilliseconds;

const record = (overrides: Partial<EventRecord>): EventRecord =>
  new EventRecord({
    accountId: 'acc-1',
    calendarId: 'cal-1',
    endUtc: instant('2026-07-07T10:00:00Z'),
    etag: null,
    id: 'evt',
    isAllDay: false,
    startUtc: instant('2026-07-07T09:00:00Z'),
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: 'x',
    updatedAt: 0,
    ...overrides,
  });

const days = Array.from({ length: 7 }, (_, index) =>
  Temporal.PlainDate.from('2026-07-06').add({ days: index }),
);

describe('groupEventsByDay', () => {
  const events = [
    record({ id: 'timed' }),
    // Crosses local midnight in Vienna: 23:30–00:30 local.
    record({
      endUtc: instant('2026-07-08T22:30:00Z'),
      id: 'overnight',
      startUtc: instant('2026-07-08T21:30:00Z'),
    }),
    record({ endDate: '2026-07-10', id: 'multi-day', isAllDay: true, startDate: '2026-07-08' }),
    record({
      endDate: '2026-07-11',
      id: 'single-all-day',
      isAllDay: true,
      startDate: '2026-07-11',
    }),
    // Starts before the grid and runs into it.
    record({ endDate: '2026-07-07', id: 'from-before', isAllDay: true, startDate: '2026-07-01' }),
    record({
      endUtc: instant('2026-08-01T10:00:00Z'),
      id: 'outside',
      startUtc: instant('2026-08-01T09:00:00Z'),
    }),
  ];

  it('matches eventsOnDay for every day of the grid, in the same order', () => {
    const grouped = groupEventsByDay(events, days, 'Europe/Vienna');
    for (const day of days) {
      expect(grouped.get(day.toString())?.map((event) => event.id)).toEqual(
        eventsOnDay(events, day, 'Europe/Vienna').map((event) => event.id),
      );
    }
  });

  it('spans all-day events across their days and clips to the grid', () => {
    const grouped = groupEventsByDay(events, days, 'UTC');
    expect(grouped.get('2026-07-06')?.map((event) => event.id)).toEqual(['from-before']);
    expect(grouped.get('2026-07-08')?.map((event) => event.id)).toContain('multi-day');
    expect(grouped.get('2026-07-09')?.map((event) => event.id)).toEqual(['multi-day']);
    expect(grouped.get('2026-07-10')?.map((event) => event.id)).toEqual([]);
    expect(grouped.get('2026-07-11')?.map((event) => event.id)).toEqual(['single-all-day']);
  });
});
