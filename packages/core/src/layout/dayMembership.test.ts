import { describe, expect, it } from 'vitest';
import { EventRecord } from '../types.ts';
import { Temporal } from '../time/temporal.ts';
import { eventsOnDay, isEventOnDay } from './dayMembership.ts';

// Europe/Vienna is UTC+2 in August: the zone where instant-overlap tests
// wrongly place UTC-midnight all-day events on two days.
const TZ = 'Europe/Vienna';

const base = {
  accountId: 'acc',
  calendarId: 'cal',
  etag: '"e"',
  status: 'confirmed' as const,
  syncedAt: 1,
  syncStatus: 'synced' as const,
  updatedAt: 1,
};

const allDay = (id: string, startDate: string, endDate: string) =>
  new EventRecord({
    ...base,
    endDate,
    endUtc: Date.parse(`${endDate}T00:00:00Z`),
    id,
    isAllDay: true,
    startDate,
    startUtc: Date.parse(`${startDate}T00:00:00Z`),
    title: id,
  });

const timed = (id: string, startUtc: number, endUtc: number) =>
  new EventRecord({ ...base, endUtc, id, isAllDay: false, startUtc, title: id });

describe('dayMembership', () => {
  it('places a single all-day event on exactly one day east of UTC', () => {
    const event = allDay('offsite', '2026-08-22', '2026-08-23');
    expect(isEventOnDay(event, Temporal.PlainDate.from('2026-08-22'), TZ)).toBe(true);
    // The bug: the UTC instants overlap Vienna's 23rd, but the event is not on it.
    expect(isEventOnDay(event, Temporal.PlainDate.from('2026-08-23'), TZ)).toBe(false);
    expect(isEventOnDay(event, Temporal.PlainDate.from('2026-08-21'), TZ)).toBe(false);
  });

  it('spans every day of a multi-day all-day event, end exclusive', () => {
    const event = allDay('trip', '2026-08-22', '2026-08-25');
    const on = (iso: string) => isEventOnDay(event, Temporal.PlainDate.from(iso), TZ);
    expect([on('2026-08-22'), on('2026-08-23'), on('2026-08-24')]).toEqual([true, true, true]);
    expect(on('2026-08-25')).toBe(false);
  });

  it('tolerates degenerate all-day events whose end equals their start', () => {
    const event = allDay('odd', '2026-08-22', '2026-08-22');
    expect(isEventOnDay(event, Temporal.PlainDate.from('2026-08-22'), TZ)).toBe(true);
    expect(isEventOnDay(event, Temporal.PlainDate.from('2026-08-23'), TZ)).toBe(false);
  });

  it('matches timed events against the local day window', () => {
    // 23:30 UTC on the 21st is 01:30 local on the 22nd in Vienna.
    const event = timed(
      'late',
      Date.parse('2026-08-21T23:30:00Z'),
      Date.parse('2026-08-22T00:30:00Z'),
    );
    expect(isEventOnDay(event, Temporal.PlainDate.from('2026-08-22'), TZ)).toBe(true);
    expect(isEventOnDay(event, Temporal.PlainDate.from('2026-08-21'), TZ)).toBe(false);
  });

  it('sorts all-day events first, then by start', () => {
    const day = Temporal.PlainDate.from('2026-08-22');
    const later = timed(
      'later',
      Date.parse('2026-08-22T14:00:00Z'),
      Date.parse('2026-08-22T15:00:00Z'),
    );
    const earlier = timed(
      'earlier',
      Date.parse('2026-08-22T08:00:00Z'),
      Date.parse('2026-08-22T09:00:00Z'),
    );
    const chip = allDay('chip', '2026-08-22', '2026-08-23');
    expect(eventsOnDay([later, earlier, chip], day, TZ).map((event) => event.id)).toEqual([
      'chip',
      'earlier',
      'later',
    ]);
  });
});
