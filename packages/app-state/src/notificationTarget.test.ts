import { BackendError, type BackendClient, EventRecord } from '@calendar/core';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { eventStartDay, findNotificationEvent } from './notificationTarget.ts';

const event = (overrides: Partial<EventRecord> = {}): EventRecord =>
  new EventRecord({
    accountId: 'acc',
    calendarId: 'cal',
    endUtc: 2000,
    etag: null,
    id: 'ev',
    isAllDay: false,
    startUtc: 1000,
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: 'Standup',
    updatedAt: 0,
    ...overrides,
  });

const target = {
  accountId: 'acc',
  calendarId: 'cal',
  eventId: 'ev',
  kind: 'event',
  startUtc: 1000,
} as const;

const client = (
  events: ReadonlyArray<EventRecord>,
  seen: Array<unknown> = [],
  stored: ReadonlyArray<EventRecord> = [],
): Pick<BackendClient, 'getEvent' | 'getEventsInRange'> => ({
  getEvent: ({ accountId, calendarId, eventId }) =>
    Effect.succeed(
      stored.find(
        (event) =>
          event.accountId === accountId && event.calendarId === calendarId && event.id === eventId,
      ) ?? null,
    ),
  getEventsInRange: (params) =>
    Effect.sync(() => {
      seen.push(params);
      return events;
    }),
});

describe('findNotificationEvent', () => {
  it('finds the occurrence by its ids and start, over a day either side', async () => {
    const seen: Array<unknown> = [];
    const wanted = event();
    const found = await findNotificationEvent(
      client([event({ calendarId: 'other' }), event({ id: 'ev2' }), wanted], seen),
      target,
    );
    expect(found).toBe(wanted);
    expect(seen).toEqual([{ rangeEndUtc: 1000 + 86_400_000, rangeStartUtc: 1000 - 86_400_000 }]);
  });

  it('prefers the exact occurrence and still finds an event that moved', async () => {
    const later = event({ endUtc: 6000, startUtc: 5000 });
    const exact = event();
    expect(await findNotificationEvent(client([later, exact]), target)).toBe(exact);
    expect(await findNotificationEvent(client([later]), target)).toBe(later);
  });

  it('finds an occurrence edited since: its id changed, its series and original start did not', async () => {
    // Drawn from the rule it was `m__1000`; once edited, Google's instance id.
    const occurrence = {
      ...target,
      eventId: 'm__1000',
      originalStartUtc: 1000,
      recurringEventId: 'm',
    };
    const edited = event({
      id: 'm_19700101T000001Z',
      originalStartUtc: 1000,
      recurringEventId: 'm',
      title: 'Standup (moved room)',
    });
    expect(await findNotificationEvent(client([event({ id: 'other' }), edited]), occurrence)).toBe(
      edited,
    );
  });

  it('finds an event moved out of the window by its stored id', async () => {
    const moved = event({ endUtc: 3 * 86_400_000, startUtc: 3 * 86_400_000 - 1000 });
    expect(await findNotificationEvent(client([], [], [moved]), target)).toBe(moved);
    // An edited occurrence moved away is stored under Google's instance id.
    const occurrence = {
      ...target,
      eventId: 'm__1000',
      originalStartUtc: 1000,
      recurringEventId: 'm',
    };
    const away = event({
      id: 'm_19700101T000001Z',
      originalStartUtc: 1000,
      recurringEventId: 'm',
      startUtc: 5 * 86_400_000,
    });
    expect(await findNotificationEvent(client([], [], [away]), occurrence)).toBe(away);
  });

  it('answers null when the event is gone or the read fails', async () => {
    expect(await findNotificationEvent(client([]), target)).toBeNull();
    expect(
      await findNotificationEvent(
        {
          getEvent: () => Effect.fail(new BackendError({ message: 'x', tag: 'Stub' })),
          getEventsInRange: () => Effect.fail(new BackendError({ message: 'x', tag: 'Stub' })),
        },
        target,
      ),
    ).toBeNull();
  });
});

describe('eventStartDay', () => {
  it('shows a timed event on its start day in the zone, an all-day one on its date', () => {
    const late = event({ startUtc: Date.parse('2026-03-04T23:30:00Z') });
    expect(eventStartDay(late, 'UTC').toString()).toBe('2026-03-04');
    expect(eventStartDay(late, 'Europe/Vienna').toString()).toBe('2026-03-05');
    const allDay = event({
      isAllDay: true,
      startDate: '2026-03-04',
      startUtc: Date.parse('2026-03-04T00:00:00Z'),
    });
    expect(eventStartDay(allDay, 'America/Los_Angeles').toString()).toBe('2026-03-04');
  });
});
