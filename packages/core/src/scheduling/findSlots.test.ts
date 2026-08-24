import { describe, expect, it } from 'vitest';
import { EventRecord } from '../types.ts';
import { findFreeSlots } from './findSlots.ts';

const TZ = 'Europe/Vienna';

const event = (startIso: string, endIso: string, overrides: Partial<EventRecord> = {}) =>
  new EventRecord({
    accountId: 'a',
    calendarId: 'c',
    endUtc: Date.parse(endIso),
    etag: null,
    id: `${startIso}`,
    isAllDay: false,
    startUtc: Date.parse(startIso),
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: 'busy',
    updatedAt: 0,
    ...overrides,
  });

// Vienna is UTC+2 in August: 09:00 local = 07:00Z.
const context = { nowUtc: Date.parse('2026-08-24T00:00:00Z'), timeZone: TZ };
const week = { windowEndDate: '2026-08-25', windowStartDate: '2026-08-25' };

describe('findFreeSlots', () => {
  it('offers the whole window on an empty day', () => {
    const slots = findFreeSlots([], { durationMinutes: 90, ...week }, context);
    expect(slots[0]).toEqual({ date: '2026-08-25', endTime: '09:30', startTime: '08:00' });
  });

  it('fits a slot into the gap between events', () => {
    const busy = [
      event('2026-08-25T06:00:00Z', '2026-08-25T08:00:00Z'), // 08–10 local
      event('2026-08-25T10:00:00Z', '2026-08-25T16:00:00Z'), // 12–18 local
    ];
    const slots = findFreeSlots(busy, { durationMinutes: 90, ...week }, context);
    // The 10:00–12:00 local gap fits 90 minutes; the tail after 18:00 too.
    expect(slots[0]).toEqual({ date: '2026-08-25', endTime: '11:30', startTime: '10:00' });
    expect(slots[1]).toEqual({ date: '2026-08-25', endTime: '19:30', startTime: '18:00' });
  });

  it('skips gaps smaller than the duration', () => {
    const busy = [
      event('2026-08-25T06:00:00Z', '2026-08-25T08:00:00Z'), // 08–10
      event('2026-08-25T09:00:00Z', '2026-08-25T18:00:00Z'), // 11–20
    ];
    // The 10–11 gap is only 60 min.
    const slots = findFreeSlots(busy, { durationMinutes: 90, ...week }, context);
    expect(slots).toHaveLength(0);
  });

  it('ignores all-day and cancelled events', () => {
    const busy = [
      event('2026-08-25T00:00:00Z', '2026-08-26T00:00:00Z', { isAllDay: true }),
      event('2026-08-25T06:00:00Z', '2026-08-25T18:00:00Z', { status: 'cancelled' }),
    ];
    const slots = findFreeSlots(busy, { durationMinutes: 60, ...week }, context);
    expect(slots[0]?.startTime).toBe('08:00');
  });

  it('respects earliest/latest and daysOfWeek', () => {
    const slots = findFreeSlots(
      [],
      {
        daysOfWeek: [3], // Wednesday only
        durationMinutes: 60,
        earliestTime: '09:00',
        latestTime: '12:00',
        windowEndDate: '2026-08-30',
        windowStartDate: '2026-08-24',
      },
      context,
    );
    // 2026-08-26 is a Wednesday.
    expect(slots.every((slot) => slot.date === '2026-08-26')).toBe(true);
    expect(slots[0]).toEqual({ date: '2026-08-26', endTime: '10:00', startTime: '09:00' });
  });

  it('never offers the past and rounds the first edge up to a quarter hour', () => {
    const now = Date.parse('2026-08-25T08:07:00Z'); // 10:07 local
    const slots = findFreeSlots(
      [],
      { durationMinutes: 60, ...week },
      { nowUtc: now, timeZone: TZ },
    );
    expect(slots[0]?.startTime).toBe('10:15');
  });

  it('keeps wall-clock bounds across the DST spring-forward day', () => {
    // Vienna springs forward on 2026-03-29 (02:00 → 03:00).
    const slots = findFreeSlots(
      [],
      {
        durationMinutes: 60,
        earliestTime: '01:00',
        latestTime: '04:00',
        windowEndDate: '2026-03-29',
        windowStartDate: '2026-03-29',
      },
      { nowUtc: Date.parse('2026-03-28T00:00:00Z'), timeZone: TZ },
    );
    // The window is wall-clock 01:00–04:00 even though only two absolute
    // hours exist; the first slot still starts at 01:00 local.
    expect(slots[0]?.startTime).toBe('01:00');
  });

  it('caps the number of slots', () => {
    const slots = findFreeSlots(
      [],
      { durationMinutes: 30, windowEndDate: '2026-09-30', windowStartDate: '2026-08-25' },
      { ...context, maxSlots: 3 },
    );
    expect(slots).toHaveLength(3);
  });

  it('handles an event spanning past the daily window end', () => {
    const busy = [event('2026-08-25T15:00:00Z', '2026-08-26T05:00:00Z')]; // 17:00 → next 07:00
    const slots = findFreeSlots(busy, { durationMinutes: 120, ...week }, context);
    // Free 08:00–17:00 local only.
    expect(slots.at(-1)?.startTime).toBe('08:00');
    expect(slots.filter((slot) => slot.startTime >= '17:00')).toHaveLength(0);
  });
});
