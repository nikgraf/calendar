import { describe, expect, it } from 'vite-plus/test';
import { Attendee, EventRecord } from '../types.ts';
import { blocksTime } from './busy.ts';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-01T08:00:00Z');

const event = (overrides: Partial<ConstructorParameters<typeof EventRecord>[0]> = {}) =>
  new EventRecord({
    accountId: 'acc',
    calendarId: 'cal',
    endUtc: T0 + HOUR,
    etag: null,
    id: 'evt',
    isAllDay: false,
    startUtc: T0,
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: 'Planning',
    updatedAt: 0,
    ...overrides,
  });

const guest = (email: string, overrides: Partial<ConstructorParameters<typeof Attendee>[0]> = {}) =>
  new Attendee({ email, responseStatus: 'accepted', ...overrides });

describe('blocksTime', () => {
  it('a timed, confirmed event blocks its time', () => {
    expect(blocksTime(event(), 'me@example.com')).toBe(true);
    expect(blocksTime(event({ transparency: 'opaque' }), undefined)).toBe(true);
  });

  it('all-day, cancelled and free events block nothing', () => {
    expect(blocksTime(event({ isAllDay: true }), 'me@example.com')).toBe(false);
    expect(blocksTime(event({ status: 'cancelled' }), 'me@example.com')).toBe(false);
    expect(blocksTime(event({ transparency: 'transparent' }), 'me@example.com')).toBe(false);
  });

  it('an invitation the user declined blocks nothing, matched by isSelf or by email', () => {
    expect(
      blocksTime(
        event({
          attendees: [guest('me@example.com', { isSelf: true, responseStatus: 'declined' })],
        }),
        undefined,
      ),
    ).toBe(false);
    expect(
      blocksTime(
        event({ attendees: [guest('ME@example.com', { responseStatus: 'declined' })] }),
        'me@example.com',
      ),
    ).toBe(false);
    // Someone else declining does not free the user's time.
    expect(
      blocksTime(
        event({ attendees: [guest('ana@example.com', { responseStatus: 'declined' })] }),
        'me@example.com',
      ),
    ).toBe(true);
  });
});
