import { Attendee, EventRecord, plainDateToUtcMs } from '@calendar/core';
import { describe, expect, it } from 'vitest';
import { isBusy, mergeBusy, otherGuests, toEventDto } from './dto.ts';
import { decodeEventRef } from './refs.ts';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-01T08:00:00Z');

const event = (overrides: Partial<ConstructorParameters<typeof EventRecord>[0]> = {}) =>
  new EventRecord({
    accountId: 'acc',
    calendarId: 'cal',
    endUtc: T0 + HOUR,
    etag: '"etag"',
    id: 'evt',
    isAllDay: false,
    startTimeZone: 'Europe/Vienna',
    startUtc: T0,
    status: 'confirmed',
    syncedAt: 5,
    syncStatus: 'synced',
    title: 'Planning',
    updatedAt: 5,
    ...overrides,
  });

const guest = (email: string, overrides: Partial<ConstructorParameters<typeof Attendee>[0]> = {}) =>
  new Attendee({ email, responseStatus: 'accepted', ...overrides });

describe('toEventDto', () => {
  it('carries a ref and ISO times, and none of the sync bookkeeping', () => {
    const dto = toEventDto(event({ location: 'Room 1' }), 'Europe/Vienna');
    expect(dto).toMatchObject({
      allDay: false,
      end: '2026-10-01T11:00:00+02:00',
      location: 'Room 1',
      recurring: false,
      start: '2026-10-01T10:00:00+02:00',
      timeZone: 'Europe/Vienna',
      title: 'Planning',
    });
    expect(decodeEventRef(dto.ref)).toEqual({
      accountId: 'acc',
      calendarId: 'cal',
      eventId: 'evt',
      kind: 'event',
    });
    for (const internal of ['etag', 'syncedAt', 'updatedAt', 'id', 'accountId', 'calendarId']) {
      expect(dto).not.toHaveProperty(internal);
    }
  });

  it('all-day: the stored exclusive end is reported as the inclusive last day', () => {
    const dto = toEventDto(
      event({
        endDate: '2026-10-04',
        endUtc: plainDateToUtcMs('2026-10-04'),
        isAllDay: true,
        startDate: '2026-10-01',
        startTimeZone: undefined,
        startUtc: plainDateToUtcMs('2026-10-01'),
      }),
      'UTC',
    );
    expect(dto).toMatchObject({ allDay: true, endDate: '2026-10-03', startDate: '2026-10-01' });
    expect(dto).not.toHaveProperty('start');
    expect(dto).not.toHaveProperty('timeZone');
  });

  it('hides booked rooms and flags queued changes', () => {
    const dto = toEventDto(
      event({
        attendees: [guest('ana@example.com'), guest('room@example.com', { isResource: true })],
        syncStatus: 'pending',
      }),
      'UTC',
    );
    expect(dto.attendees).toEqual([{ email: 'ana@example.com', response: 'accepted' }]);
    expect(dto.pendingSync).toBe(true);
  });
});

describe('busy time', () => {
  it('all-day, cancelled and declined events block nothing', () => {
    expect(isBusy(event(), 'me@example.com')).toBe(true);
    expect(isBusy(event({ isAllDay: true }), 'me@example.com')).toBe(false);
    expect(isBusy(event({ status: 'cancelled' }), 'me@example.com')).toBe(false);
    expect(
      isBusy(
        event({ attendees: [guest('ME@example.com', { responseStatus: 'declined' })] }),
        'me@example.com',
      ),
    ).toBe(false);
    // Someone else declining does not free the user's time.
    expect(
      isBusy(
        event({ attendees: [guest('ana@example.com', { responseStatus: 'declined' })] }),
        'me@example.com',
      ),
    ).toBe(true);
  });

  it('merges overlapping and touching blocks and clips them to the range', () => {
    const range = { endUtc: T0 + 6 * HOUR, startUtc: T0 };
    const blocks = mergeBusy(
      [
        { endUtc: T0 + 2 * HOUR, startUtc: T0 + HOUR },
        { endUtc: T0 + 2.5 * HOUR, startUtc: T0 + 1.5 * HOUR },
        { endUtc: T0 + 3 * HOUR, startUtc: T0 + 2.5 * HOUR },
        { endUtc: T0 + 8 * HOUR, startUtc: T0 + 5 * HOUR },
        { endUtc: T0 - HOUR, startUtc: T0 - 2 * HOUR },
      ],
      range,
    );
    expect(blocks).toEqual([
      { endUtc: T0 + 3 * HOUR, startUtc: T0 + HOUR },
      { endUtc: T0 + 6 * HOUR, startUtc: T0 + 5 * HOUR },
    ]);
  });
});

describe('otherGuests', () => {
  it('is everyone a write would reach: not the user, not rooms', () => {
    const record = event({
      attendees: [
        guest('me@example.com', { isOrganizer: true }),
        guest('self-flagged@example.com', { isSelf: true }),
        guest('room@example.com', { isResource: true }),
        guest('ana@example.com'),
      ],
    });
    expect(otherGuests(record, 'ME@example.com').map((attendee) => attendee.email)).toEqual([
      'ana@example.com',
    ]);
    expect(otherGuests(event(), 'me@example.com')).toEqual([]);
  });
});
