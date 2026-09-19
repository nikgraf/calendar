import { EventRecord, GeoLocation } from '@calendar/core';
import { describe, expect, it } from 'vitest';
import { draftToEventWrite, mapAppleCalendar, mapAppleEvent, toEventWrite } from './map.ts';
import type { AppleEventJson } from './protocol.ts';

const context = { deviceTimeZone: 'Europe/Vienna', now: 1000 };

const event = (overrides: Partial<AppleEventJson> = {}): AppleEventJson => ({
  calendarId: 'cal-home',
  endUtc: Date.UTC(2026, 6, 14, 10),
  hasRecurrence: false,
  id: 'ek-1',
  isAllDay: false,
  isDetached: false,
  startUtc: Date.UTC(2026, 6, 14, 9),
  status: 'confirmed',
  timeZone: 'America/New_York',
  title: 'Dentist',
  updatedAt: 500,
  ...overrides,
});

describe('mapAppleEvent', () => {
  it('maps a single event under the Apple Calendar account', () => {
    const record = mapAppleEvent(event(), context);
    expect(record).toBeInstanceOf(EventRecord);
    expect(record.accountId).toBe('apple-calendar');
    expect(record.id).toBe('ek-1');
    expect(record.recurringEventId).toBeUndefined();
    expect(record.startTimeZone).toBe('America/New_York');
    expect(record.etag).toBeNull();
    expect(record.syncStatus).toBe('synced');
  });

  it('reads a floating event in the device zone', () => {
    const { timeZone: _zone, ...floating } = event();
    expect(mapAppleEvent(floating, context).startTimeZone).toBe('Europe/Vienna');
  });

  it('names an occurrence by its series and its slot', () => {
    const slot = Date.UTC(2026, 6, 21, 9);
    const record = mapAppleEvent(
      event({ hasRecurrence: true, occurrenceStartUtc: slot, startUtc: slot + 3_600_000 }),
      context,
    );
    expect(record.id).toBe(`ek-1__${slot}`);
    expect(record.recurringEventId).toBe('ek-1');
    expect(record.originalStartUtc).toBe(slot);
  });

  it('keeps all-day days as dates with an exclusive end', () => {
    const record = mapAppleEvent(
      event({ endDate: '2026-07-16', isAllDay: true, startDate: '2026-07-14' }),
      context,
    );
    expect(record.startDate).toBe('2026-07-14');
    expect(record.endDate).toBe('2026-07-16');
    expect(record.startUtc).toBe(Date.UTC(2026, 6, 14));
    expect(record.endUtc).toBe(Date.UTC(2026, 6, 16));
    expect(record.startTimeZone).toBeUndefined();
  });

  it('shows a meeting URL as the join link and ignores other URLs', () => {
    expect(
      mapAppleEvent(event({ url: 'https://meet.google.com/abc-defg-hij' }), context).hangoutLink,
    ).toBe('https://meet.google.com/abc-defg-hij');
    expect(
      mapAppleEvent(event({ url: 'https://example.com/agenda' }), context).hangoutLink,
    ).toBeUndefined();
  });

  it('keeps coordinates only with location text', () => {
    const geo = { lat: 48.2, lng: 16.37, name: 'Stephansplatz' };
    expect(
      mapAppleEvent(event({ geo, location: 'Stephansplatz, Wien' }), context).geo?.source,
    ).toBe('Stephansplatz, Wien');
    expect(mapAppleEvent(event({ geo }), context).geo).toBeUndefined();
  });

  it('carries read-only attendees and a cancelled status', () => {
    const record = mapAppleEvent(
      event({
        attendees: [
          { email: 'ana@example.com', isOrganizer: true, isSelf: false, status: 'accepted' },
        ],
        status: 'cancelled',
      }),
      context,
    );
    expect(record.attendees?.[0]?.isOrganizer).toBe(true);
    expect(record.status).toBe('cancelled');
  });
});

describe('mapAppleCalendar', () => {
  it('maps writability, default and source', () => {
    const calendar = mapAppleCalendar(
      {
        allowsModifications: false,
        colorHex: '#FF2968',
        id: 'cal-holidays',
        isDefault: false,
        sourceTitle: 'Subscribed Calendars',
        sourceType: 'subscribed',
        title: 'Holidays',
        type: 'subscription',
      },
      { deviceTimeZone: 'Europe/Vienna' },
    );
    expect(calendar.accessRole).toBe('reader');
    expect(calendar.colorHex).toBe('#ff2968');
    expect(calendar.provider).toBe('apple');
    expect(calendar.sourceTitle).toBe('Subscribed Calendars');
    expect(calendar.isVisible).toBe(true);
  });
});

describe('writes', () => {
  it('turns emptied text into clears and passes coordinates', () => {
    expect(
      toEventWrite({
        description: '',
        geo: new GeoLocation({ lat: 1, lng: 2, source: 'Here' }),
        location: 'Here',
        title: 'T',
      }),
    ).toEqual({ description: null, geo: { lat: 1, lng: 2 }, location: 'Here', title: 'T' });
    expect(toEventWrite({ geo: null, location: '' })).toEqual({ geo: null, location: null });
  });

  it('converts a draft rule and refuses one EventKit cannot store', () => {
    const base = {
      accountId: 'apple-calendar',
      calendarId: 'cal-home',
      endUtc: 2,
      isAllDay: false,
      startTimeZone: 'Europe/Vienna',
      startUtc: 1,
      title: 'Standup',
    };
    const ok = draftToEventWrite({ ...base, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] }, 'UTC');
    expect(ok._tag).toBe('ok');
    if (ok._tag === 'ok') {
      expect(ok.write.recurrence).toEqual([
        { byDay: [{ weekday: 'MO' }], freq: 'weekly', interval: 1 },
      ]);
      expect(ok.write.timeZone).toBe('Europe/Vienna');
    }
    expect(
      draftToEventWrite({ ...base, recurrence: ['RRULE:FREQ=DAILY;BYHOUR=9,17'] }, 'UTC'),
    ).toEqual({ _tag: 'unsupported', parts: ['BYHOUR'] });
  });
});
