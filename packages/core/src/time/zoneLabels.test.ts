import { describe, expect, it } from 'vite-plus/test';
import { Temporal } from './temporal.ts';
import {
  draftZoneRange,
  formatZoneRange,
  formatZoneTimeRange,
  secondaryHourLabels,
  zoneHourLabel,
} from './zoneLabels.ts';

const vienna = 'Europe/Vienna';
const winterDay = Temporal.PlainDate.from('2026-01-15');

const at = (iso: string): number => Date.parse(iso);

describe('zoneHourLabel', () => {
  it('shows the hour the other zone has when the primary row is hour:00', () => {
    expect(zoneHourLabel(winterDay, 8, vienna, 'America/Los_Angeles')).toBe('11 PM');
    expect(zoneHourLabel(winterDay, 8, vienna, 'Asia/Tokyo')).toBe('4 PM');
    expect(zoneHourLabel(winterDay, 0, vienna, 'Asia/Tokyo')).toBe('8 AM');
  });

  it('shows minutes for a zone offset by a half hour', () => {
    expect(zoneHourLabel(winterDay, 8, vienna, 'Asia/Kolkata')).toBe('12:30 PM');
  });

  it('survives the spring-forward gap in the primary zone', () => {
    // 2026-03-29 02:00 does not exist in Vienna; 'compatible' moves it forward.
    expect(() =>
      zoneHourLabel(Temporal.PlainDate.from('2026-03-29'), 2, vienna, 'UTC'),
    ).not.toThrow();
    expect(zoneHourLabel(Temporal.PlainDate.from('2026-03-29'), 2, vienna, 'UTC')).toBe('1 AM');
  });

  it('joins the secondary zones in settings order', () => {
    expect(secondaryHourLabels(winterDay, 8, vienna, ['Asia/Tokyo', 'America/Los_Angeles'])).toBe(
      '4 PM · 11 PM',
    );
    expect(secondaryHourLabels(winterDay, 8, vienna, [])).toBe('');
  });
});

describe('formatZoneTimeRange', () => {
  it('elides a shared period', () => {
    expect(formatZoneTimeRange(at('2026-01-15T13:00:00Z'), at('2026-01-15T14:00:00Z'), 'UTC')).toBe(
      '1:00 – 2:00 PM',
    );
  });

  it('spells both periods across noon or midnight', () => {
    expect(formatZoneTimeRange(at('2026-01-15T23:00:00Z'), at('2026-01-16T00:00:00Z'), 'UTC')).toBe(
      '11:00 PM – 12:00 AM',
    );
    expect(formatZoneTimeRange(at('2026-01-15T11:30:00Z'), at('2026-01-15T12:30:00Z'), 'UTC')).toBe(
      '11:30 AM – 12:30 PM',
    );
  });

  it('never elides across a whole day', () => {
    expect(formatZoneTimeRange(at('2026-01-15T13:00:00Z'), at('2026-01-16T13:00:00Z'), 'UTC')).toBe(
      '1:00 PM – 1:00 PM',
    );
  });

  it('labels every zone with its city', () => {
    expect(
      formatZoneRange(at('2026-01-15T13:00:00Z'), at('2026-01-15T14:00:00Z'), [
        'America/Los_Angeles',
        'Asia/Kolkata',
      ]),
    ).toBe('5:00 – 6:00 AM Los Angeles · 6:30 – 7:30 PM Kolkata');
  });
});

describe('draftZoneRange', () => {
  const fields = { date: '2026-01-15', endTime: '10:00', isAllDay: false, startTime: '09:00' };

  it('formats a timed draft in the secondary zones', () => {
    expect(draftZoneRange(fields, vienna, ['Asia/Kolkata'])).toBe('1:30 – 2:30 PM Kolkata');
  });

  it('is null for all-day, empty times, no zones or an unbuildable draft', () => {
    expect(draftZoneRange({ ...fields, isAllDay: true }, vienna, ['Asia/Kolkata'])).toBeNull();
    expect(draftZoneRange({ ...fields, startTime: '' }, vienna, ['Asia/Kolkata'])).toBeNull();
    expect(draftZoneRange(fields, vienna, [])).toBeNull();
    expect(draftZoneRange({ ...fields, endTime: 'nope' }, vienna, ['Asia/Kolkata'])).toBeNull();
  });
});
