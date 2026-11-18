import { expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { EventRecord } from '../types.ts';
import { findFreeSlots } from './findSlots.ts';

const Minute = Schema.Int.check(Schema.isBetween({ maximum: 1199, minimum: 480 }));
const Duration = Schema.Int.check(Schema.isBetween({ maximum: 180, minimum: 1 }));
const Busy = Schema.Array(Schema.Struct({ duration: Duration, start: Minute })).check(
  Schema.isMaxLength(30),
);
const midnight = Date.parse('2026-08-24T00:00:00Z');
const minuteOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

it.prop(
  'offered slots fit the requested duration and bounds, avoid busy time and ignore input order',
  { busy: Busy, duration: Duration },
  ({ busy, duration }) => {
    const events = busy.map(
      (interval, index) =>
        new EventRecord({
          accountId: 'account',
          calendarId: 'calendar',
          endUtc: midnight + (interval.start + interval.duration) * 60_000,
          etag: null,
          id: String(index),
          isAllDay: false,
          startUtc: midnight + interval.start * 60_000,
          status: 'confirmed',
          syncedAt: 0,
          syncStatus: 'synced',
          title: 'Busy',
          updatedAt: 0,
        }),
    );
    const constraints = {
      durationMinutes: duration,
      windowEndDate: '2026-08-24',
      windowStartDate: '2026-08-24',
    };
    const context = { maxSlots: 100, nowUtc: midnight, timeZone: 'UTC' };
    const slots = findFreeSlots(events, constraints, context);
    for (const slot of slots) {
      const start = minuteOf(slot.startTime);
      const end = minuteOf(slot.endTime);
      expect(slot.date).toBe('2026-08-24');
      expect(end - start).toBe(duration);
      expect(start).toBeGreaterThanOrEqual(480);
      expect(end).toBeLessThanOrEqual(1200);
      expect(
        busy.every(
          (interval) => end <= interval.start || start >= interval.start + interval.duration,
        ),
      ).toBe(true);
    }
    // A minute-grid oracle also catches an implementation that returns no slots.
    const anyGap = Array.from({ length: 721 - duration }, (_, index) => index + 480).some((start) =>
      busy.every(
        (interval) =>
          start + duration <= interval.start || start >= interval.start + interval.duration,
      ),
    );
    expect(slots.length > 0).toBe(anyGap);
    expect(findFreeSlots(events.toReversed(), constraints, context)).toEqual(slots);
  },
);
