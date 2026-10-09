import { describe, expect, it } from 'vite-plus/test';
import { dateForPicker, dateStringFromPicker, timeStringFromPicker } from './pickerDates.ts';

describe('pickerDates', () => {
  it('round-trips a primary-zone wall clock through an instant', () => {
    // 2026-01-15 09:00 in Kolkata is 03:30 UTC, whatever the host's zone.
    const picked = dateForPicker('2026-01-15', '09:00', 'Asia/Kolkata');
    expect(picked.getTime()).toBe(Date.parse('2026-01-15T03:30:00Z'));
    expect(dateStringFromPicker(picked, 'Asia/Kolkata')).toBe('2026-01-15');
    expect(timeStringFromPicker(picked, 'Asia/Kolkata')).toBe('09:00');
  });

  it('keeps the date across a zone where the instant is the previous day', () => {
    const picked = dateForPicker('2026-01-15', '00:30', 'Asia/Tokyo');
    expect(dateStringFromPicker(picked, 'Asia/Tokyo')).toBe('2026-01-15');
    expect(dateStringFromPicker(picked, 'UTC')).toBe('2026-01-14');
  });

  it('defaults an empty time to 09:00 and a bad date to now', () => {
    expect(timeStringFromPicker(dateForPicker('2026-01-15', '', 'UTC'), 'UTC')).toBe('09:00');
    expect(Number.isNaN(dateForPicker('nope', '09:00', 'UTC').getTime())).toBe(false);
  });
});
