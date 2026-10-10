import { describe, expect, it } from 'vite-plus/test';
import { eventIdentity, findSameEvent, isSameEvent } from './eventIdentity.ts';
import { assembleWindow } from './recurrence/window.ts';
import { EventRecord } from './types.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const start = Date.parse('2026-10-05T09:00:00Z');

const event = (overrides: Partial<EventRecord> = {}): EventRecord =>
  new EventRecord({
    accountId: 'acc',
    calendarId: 'cal',
    endUtc: start + HOUR,
    etag: null,
    id: 'ev',
    isAllDay: false,
    startTimeZone: 'UTC',
    startUtc: start,
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: 'Standup',
    updatedAt: 0,
    ...overrides,
  });

describe('eventIdentity', () => {
  it('is the same for a refreshed copy of a single event, whatever changed in it', () => {
    expect(eventIdentity(event({ description: 'Notes', startUtc: start + DAY }))).toBe(
      eventIdentity(event()),
    );
  });

  it('tells events apart by account, calendar and id', () => {
    const identity = eventIdentity(event());
    expect(eventIdentity(event({ id: 'other' }))).not.toBe(identity);
    expect(eventIdentity(event({ calendarId: 'other' }))).not.toBe(identity);
    // Google ids are global: a shared calendar in two accounts holds the same id twice.
    expect(eventIdentity(event({ accountId: 'other' }))).not.toBe(identity);
  });

  it('keeps an occurrence once it is edited on its own: its id changes, its slot does not', () => {
    const master = event({ id: 'm', recurrence: ['RRULE:FREQ=DAILY;COUNT=3'] });
    const [, drawn] = assembleWindow(
      { masters: [master], overrides: [], singles: [] },
      start,
      start + 3 * DAY,
    );
    expect(drawn?.id).toBe(`m__${String(start + DAY)}`);
    // The edit moved it an hour; Google stores it under its instance id.
    const edited = event({
      id: 'm_20261006T090000Z',
      originalStartUtc: start + DAY,
      recurringEventId: 'm',
      startUtc: start + DAY + HOUR,
    });
    const [, redrawn] = assembleWindow(
      { masters: [master], overrides: [edited], singles: [edited] },
      start,
      start + 3 * DAY,
    );
    expect(redrawn).toBe(edited);
    expect(eventIdentity(edited)).toBe(eventIdentity(drawn!));
    // Another occurrence of the same series is another event.
    expect(eventIdentity(edited)).not.toBe(
      eventIdentity(event({ id: 'm__x', originalStartUtc: start, recurringEventId: 'm' })),
    );
  });

  it('names an Apple occurrence by its series and slot as well', () => {
    const slot = start + DAY;
    const drawn = event({
      id: `ek-1__${String(slot)}`,
      originalStartUtc: slot,
      recurringEventId: 'ek-1',
    });
    // Moved on its own in Calendar.app: same slot, new start.
    const moved = event({ ...drawn, startUtc: slot + 2 * HOUR });
    expect(eventIdentity(moved)).toBe(eventIdentity(drawn));
  });
});

describe('isSameEvent', () => {
  it('agrees with eventIdentity on every pair', () => {
    const rows = [
      event(),
      event({ description: 'Notes' }),
      event({ id: 'other' }),
      event({ accountId: 'other' }),
      event({ id: 'm__1', originalStartUtc: 1, recurringEventId: 'm' }),
      event({ id: 'm_19700101T000000Z', originalStartUtc: 1, recurringEventId: 'm' }),
      event({ id: 'm__2', originalStartUtc: 2, recurringEventId: 'm' }),
      // A single whose id is an occurrence's: still not that occurrence.
      event({ id: 'm__1' }),
    ];
    for (const a of rows) {
      for (const b of rows) {
        expect(isSameEvent(a, b)).toBe(eventIdentity(a) === eventIdentity(b));
      }
    }
  });
});

describe('findSameEvent', () => {
  it('finds the row an event is now, or nothing once it is gone', () => {
    const opened = event();
    const refreshed = event({ description: 'Bring the bands' });
    const rows = [event({ id: 'other' }), refreshed];
    expect(findSameEvent(rows, opened)).toBe(refreshed);
    expect(findSameEvent([event({ id: 'other' })], opened)).toBeUndefined();
  });
});
