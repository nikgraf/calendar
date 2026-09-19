import { Attendee, EventRecord, GEO_PROPERTY_KEYS, GeoLocation } from '@calendar/core';
import { describe, expect, it } from 'vitest';
import {
  hasGuests,
  mapGcalCalendar,
  mapGcalEvent,
  toGcalAttendees,
  toGcalEventInput,
  toGcalGeoInsert,
  toGcalGeoPatch,
} from './mapEvent.ts';

const context = {
  accountId: 'acc-1',
  calendarId: 'primary',
  defaultTimeZone: 'Europe/Vienna',
  syncedAt: 1000,
};

describe('mapGcalEvent', () => {
  it('maps a timed event with zone and attendees', () => {
    const record = mapGcalEvent(
      {
        attendees: [
          { email: 'a@example.com', responseStatus: 'accepted', self: true },
          { email: 'room@resource.calendar.google.com', resource: true },
        ],
        end: { dateTime: '2026-07-02T15:00:00+02:00' },
        etag: '"e1"',
        id: 'evt1',
        start: {
          dateTime: '2026-07-02T14:00:00+02:00',
          timeZone: 'Europe/Vienna',
        },
        status: 'confirmed',
        summary: 'Standup',
        updated: '2026-07-01T10:00:00.000Z',
      },
      context,
    );

    expect(record?.title).toBe('Standup');
    expect(record?.isAllDay).toBe(false);
    expect(record?.startUtc).toBe(Date.parse('2026-07-02T12:00:00Z'));
    expect(record?.endUtc).toBe(Date.parse('2026-07-02T13:00:00Z'));
    expect(record?.startTimeZone).toBe('Europe/Vienna');
    expect(record?.etag).toBe('"e1"');
    // Rooms stay (flagged) so a write-back never drops them; humans unflagged.
    expect(record?.attendees).toHaveLength(2);
    expect(record?.attendees?.[0]?.isSelf).toBe(true);
    expect(record?.attendees?.[0]?.isResource).toBeUndefined();
    expect(record?.attendees?.[1]?.isResource).toBe(true);
  });

  it('maps an all-day event to date strings and UTC midnights', () => {
    const record = mapGcalEvent(
      {
        end: { date: '2026-07-04' },
        id: 'evt2',
        start: { date: '2026-07-02' },
        summary: 'Conference',
      },
      context,
    );
    expect(record?.isAllDay).toBe(true);
    expect(record?.startDate).toBe('2026-07-02');
    expect(record?.endDate).toBe('2026-07-04');
    expect(record?.startUtc).toBe(Date.parse('2026-07-02T00:00:00Z'));
    expect(record?.startTimeZone).toBeUndefined();
  });

  it('returns null for an unparsable dateTime instead of throwing', () => {
    expect(
      mapGcalEvent(
        {
          end: { dateTime: '2026-07-02T13:00:00Z' },
          id: 'bad',
          start: { dateTime: 'not-a-timestamp' },
        },
        { accountId: 'acc-1', calendarId: 'cal-1', defaultTimeZone: 'UTC', syncedAt: 0 },
      ),
    ).toBeNull();
  });

  it('returns null for tombstones without times', () => {
    expect(mapGcalEvent({ id: 'gone', status: 'cancelled' }, context)).toBeNull();
  });

  it('keeps override linkage fields', () => {
    const record = mapGcalEvent(
      {
        end: { dateTime: '2026-07-02T16:00:00Z' },
        id: 'master_20260702T140000Z',
        originalStartTime: { dateTime: '2026-07-02T14:00:00Z' },
        recurringEventId: 'master',
        start: { dateTime: '2026-07-02T15:00:00Z' },
        summary: 'Moved standup',
      },
      context,
    );
    expect(record?.recurringEventId).toBe('master');
    expect(record?.originalStartUtc).toBe(Date.parse('2026-07-02T14:00:00Z'));
  });
});

describe('mapGcalCalendar', () => {
  it('resolves color, visibility, and summary override', () => {
    const calendar = mapGcalCalendar(
      {
        accessRole: 'owner',
        colorId: '7',
        id: 'cal-1',
        primary: true,
        selected: true,
        summary: 'Work',
        summaryOverride: 'Work (renamed)',
        timeZone: 'Europe/Vienna',
      },
      {
        accountId: 'acc-1',
        colorFromId: (id) => (id === '7' ? '#42d692' : undefined),
      },
    );
    expect(calendar.colorHex).toBe('#42d692');
    expect(calendar.summary).toBe('Work (renamed)');
    expect(calendar.isPrimary).toBe(true);
    expect(calendar.isVisible).toBe(true);
  });

  it('preserves the local visibility toggle across syncs', () => {
    const calendar = mapGcalCalendar(
      { accessRole: 'reader', id: 'cal-2', selected: true },
      {
        accountId: 'acc-1',
        colorFromId: () => undefined,
        previousVisibility: false,
      },
    );
    expect(calendar.isVisible).toBe(false);
  });
});

describe('meeting links', () => {
  it('maps hangoutLink and falls back to the video entry point', () => {
    const base = {
      end: { dateTime: '2026-07-04T11:00:00Z' },
      id: 'e1',
      start: { dateTime: '2026-07-04T10:00:00Z', timeZone: 'UTC' },
      status: 'confirmed',
      summary: 'Call',
    };
    const context = {
      accountId: 'a',
      calendarId: 'c',
      defaultTimeZone: 'UTC',
      syncedAt: 1,
    };
    expect(
      mapGcalEvent({ ...base, hangoutLink: 'https://meet.google.com/abc' }, context)?.hangoutLink,
    ).toBe('https://meet.google.com/abc');
    expect(
      mapGcalEvent(
        {
          ...base,
          conferenceData: {
            entryPoints: [
              { entryPointType: 'phone', uri: 'tel:+1' },
              { entryPointType: 'video', uri: 'https://meet.google.com/xyz' },
            ],
          },
        },
        context,
      )?.hangoutLink,
    ).toBe('https://meet.google.com/xyz');
  });
});

describe('toGcalEventInput', () => {
  it('round-trips a timed event through the input shape', () => {
    const record = mapGcalEvent(
      {
        end: { dateTime: '2026-07-02T15:00:00+02:00' },
        id: 'evt1',
        start: {
          dateTime: '2026-07-02T14:00:00+02:00',
          timeZone: 'Europe/Vienna',
        },
        summary: 'Standup',
      },
      context,
    );
    const input = toGcalEventInput(record!);
    expect(input.summary).toBe('Standup');
    expect(input.start.dateTime).toBe('2026-07-02T12:00:00Z');
    expect(input.start.timeZone).toBe('Europe/Vienna');
    expect(input.end.date).toBeUndefined();
  });

  it('uses date fields for all-day events', () => {
    const record = mapGcalEvent(
      {
        end: { date: '2026-07-04' },
        id: 'evt2',
        start: { date: '2026-07-02' },
        summary: 'Conference',
      },
      context,
    );
    const input = toGcalEventInput(record!);
    expect(input.start.date).toBe('2026-07-02');
    expect(input.end.date).toBe('2026-07-04');
    expect(input.start.dateTime).toBeUndefined();
  });
});

describe('toGcalAttendees', () => {
  const base = mapGcalEvent(
    {
      end: { dateTime: '2026-07-02T15:00:00+02:00' },
      id: 'evt1',
      start: { dateTime: '2026-07-02T14:00:00+02:00', timeZone: 'Europe/Vienna' },
      summary: 'Standup',
    },
    context,
  )!;

  it('never rides on the plain input and is undefined without guests', () => {
    expect('attendees' in toGcalEventInput(base)).toBe(false);
    expect(toGcalAttendees(base)).toBeUndefined();
    expect(hasGuests(base)).toBe(false);
  });

  it('emits email, response, display name and the resource flag per attendee', () => {
    const record = new EventRecord({
      ...base,
      attendees: [
        new Attendee({ displayName: 'Alice', email: 'a@example.com', responseStatus: 'accepted' }),
        new Attendee({
          email: 'room@resource.calendar.google.com',
          isResource: true,
          responseStatus: 'accepted',
        }),
      ],
    });
    expect(toGcalAttendees(record)).toEqual([
      {
        displayName: 'Alice',
        email: 'a@example.com',
        resource: undefined,
        responseStatus: 'accepted',
      },
      {
        displayName: undefined,
        email: 'room@resource.calendar.google.com',
        resource: true,
        responseStatus: 'accepted',
      },
    ]);
    expect(hasGuests(record)).toBe(true);
    // A room alone is nobody to notify.
    expect(hasGuests(new EventRecord({ ...record, attendees: [record.attendees![1]!] }))).toBe(
      false,
    );
  });

  it('emits an empty array so a patch clears the guests', () => {
    expect(toGcalAttendees(new EventRecord({ ...base, attendees: [] }))).toEqual([]);
  });
});

describe('location coordinates', () => {
  const location = 'Blue Bottle Coffee, 66 Mint St, San Francisco';
  const timed = {
    end: { dateTime: '2026-07-02T15:00:00Z' },
    id: 'evt-geo',
    location,
    start: { dateTime: '2026-07-02T14:00:00Z' },
    summary: 'Coffee',
  };
  const properties = {
    [GEO_PROPERTY_KEYS.coordinates]: '37.7823,-122.4076',
    [GEO_PROPERTY_KEYS.name]: 'Blue Bottle Coffee',
    [GEO_PROPERTY_KEYS.source]: location,
  };

  it('reads coordinates derived from the current location text', () => {
    const record = mapGcalEvent({ ...timed, extendedProperties: { private: properties } }, context);
    expect(record?.geo).toEqual(
      new GeoLocation({
        lat: 37.7823,
        lng: -122.4076,
        name: 'Blue Bottle Coffee',
        source: location,
      }),
    );
  });

  it('ignores coordinates once another client changed the location', () => {
    const record = mapGcalEvent(
      { ...timed, extendedProperties: { private: properties }, location: 'Office' },
      context,
    );
    expect(record?.geo).toBeUndefined();
  });

  it('ignores events without or with unrelated properties', () => {
    expect(mapGcalEvent(timed, context)?.geo).toBeUndefined();
    expect(
      mapGcalEvent({ ...timed, extendedProperties: { private: { other: 'x' } } }, context)?.geo,
    ).toBeUndefined();
  });

  it('inserts the keys only when there are coordinates', () => {
    const record = mapGcalEvent(
      { ...timed, extendedProperties: { private: properties } },
      context,
    )!;
    expect(toGcalGeoInsert(record)).toEqual({ extendedProperties: { private: properties } });
    expect(toGcalGeoInsert(new EventRecord({ ...record, geo: undefined }))).toEqual({});
  });

  it('patches the keys, deletes them with nulls when the edit dropped them, else nothing', () => {
    const record = mapGcalEvent(
      { ...timed, extendedProperties: { private: properties } },
      context,
    )!;
    expect(toGcalGeoPatch(record, false)).toEqual({ extendedProperties: { private: properties } });
    expect(toGcalGeoPatch(new EventRecord({ ...record, geo: undefined }), false)).toEqual({});
    expect(toGcalGeoPatch(new EventRecord({ ...record, geo: undefined }), true)).toEqual({
      extendedProperties: {
        private: {
          [GEO_PROPERTY_KEYS.coordinates]: null,
          [GEO_PROPERTY_KEYS.name]: null,
          [GEO_PROPERTY_KEYS.source]: null,
        },
      },
    });
  });

  it('keeps coordinates out of the plain input shape', () => {
    const record = mapGcalEvent(
      { ...timed, extendedProperties: { private: properties } },
      context,
    )!;
    expect(toGcalEventInput(record).extendedProperties).toBeUndefined();
  });
});
