import { Attendee, EventRecord } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { eventReadout } from './eventReadout.ts';

const event = (overrides: Partial<EventRecord> = {}): EventRecord =>
  new EventRecord({
    accountId: 'acc',
    calendarId: 'cal',
    endUtc: Date.parse('2026-03-05T00:15:00Z'),
    etag: null,
    id: 'ev',
    isAllDay: false,
    startUtc: Date.parse('2026-03-04T23:30:00Z'),
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: 'Late call',
    updatedAt: 0,
    ...overrides,
  });

describe('eventReadout', () => {
  it('reads a timed event as wall clock in the zone, on its local start day', () => {
    expect(eventReadout(event(), 'Europe/Vienna')).toEqual({
      attendees: [],
      date: '2026-03-05',
      description: '',
      endTime: '01:15',
      isAllDay: false,
      location: '',
      startTime: '00:30',
      title: 'Late call',
    });
    expect(eventReadout(event(), 'UTC')).toMatchObject({
      date: '2026-03-04',
      endTime: '00:15',
      startTime: '23:30',
    });
  });

  it('reads an all-day event on its own date, with no times', () => {
    const allDay = event({
      endDate: '2026-03-05',
      endUtc: Date.parse('2026-03-05T00:00:00Z'),
      isAllDay: true,
      startDate: '2026-03-04',
      startUtc: Date.parse('2026-03-04T00:00:00Z'),
    });
    expect(eventReadout(allDay, 'America/Los_Angeles')).toMatchObject({
      date: '2026-03-04',
      endTime: '',
      isAllDay: true,
      startTime: '',
    });
  });

  it('carries the notes, the place and the guests, leaving rooms out', () => {
    const ana = new Attendee({ email: 'ana@example.com', responseStatus: 'accepted' });
    const room = new Attendee({
      displayName: 'Room 4B',
      email: 'room-4b@resource.calendar.google.com',
      isResource: true,
      responseStatus: 'accepted',
    });
    expect(
      eventReadout(
        event({ attendees: [ana, room], description: 'Agenda', location: 'Blue Bottle' }),
        'UTC',
      ),
    ).toMatchObject({ attendees: [ana], description: 'Agenda', location: 'Blue Bottle' });
  });
});
