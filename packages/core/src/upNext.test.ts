import { describe, expect, it } from 'vite-plus/test';
import { Attendee, EventRecord } from './types.ts';
import { UP_NEXT_HORIZON_MS, upNext } from './upNext.ts';

const HOUR = 3_600_000;
const now = Date.parse('2026-10-02T10:20:00Z');

const event = (id: string, startOffsetH: number, overrides: Partial<EventRecord> = {}) =>
  new EventRecord({
    accountId: 'acc',
    calendarId: 'cal',
    endUtc: now + (startOffsetH + 1) * HOUR,
    etag: null,
    id,
    isAllDay: false,
    startUtc: now + startOffsetH * HOUR,
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: id,
    updatedAt: 0,
    ...overrides,
  });

describe('upNext', () => {
  it('picks the earliest event that has not ended, under way first', () => {
    const next = upNext([event('later', 2), event('now', -0.5), event('soon', 0.5)], now);
    expect(next?.event.id).toBe('now');
    expect(next?.startsInMs).toBe(-0.5 * HOUR);
    expect(upNext([event('later', 2), event('soon', 0.5)], now)?.event.id).toBe('soon');
  });

  it('skips what is over, cancelled, declined, all-day, or beyond the horizon', () => {
    expect(upNext([event('over', -3)], now)).toBeUndefined();
    expect(upNext([event('cancelled', 1, { status: 'cancelled' })], now)).toBeUndefined();
    expect(
      upNext(
        [
          event('declined', 1, {
            attendees: [
              new Attendee({ email: 'me@example.com', isSelf: true, responseStatus: 'declined' }),
            ],
          }),
        ],
        now,
      ),
    ).toBeUndefined();
    expect(upNext([event('allDay', 1, { isAllDay: true })], now)).toBeUndefined();
    expect(upNext([event('tomorrow', 20)], now)).toBeUndefined();
    expect(upNext([event('tomorrow', 20)], now, 24 * HOUR)?.event.id).toBe('tomorrow');
    expect(UP_NEXT_HORIZON_MS).toBe(12 * HOUR);
  });

  it('carries the meeting link', () => {
    const next = upNext(
      [event('call', 1, { hangoutLink: 'https://meet.google.com/abc-defg-hij' })],
      now,
    );
    expect(next?.joinUrl).toBe('https://meet.google.com/abc-defg-hij');
    expect(upNext([event('lunch', 1)], now)?.joinUrl).toBeUndefined();
  });
});
