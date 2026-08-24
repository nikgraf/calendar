import type { LanguageModel } from '@calendar/ai';
import { EventRecord, plainDateToUtcMs, type BackendClient } from '@calendar/core';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { makeFindSlots } from './findTime.ts';

const TZ = 'Europe/Vienna';

const model = (parse: unknown): LanguageModel => ({
  generateJson: async () => parse,
  status: async () => 'ready',
});

// Only getEventsInRange is consulted; the rest of the client is irrelevant
// to the pipeline (the appleModelDetail precedent for partial fakes).
const backendWith = (
  getEventsInRange: BackendClient['getEventsInRange'],
  calls?: Array<{ rangeEndUtc: number; rangeStartUtc: number }>,
): BackendClient =>
  ({
    getEventsInRange: (payload: { rangeEndUtc: number; rangeStartUtc: number }) => {
      calls?.push(payload);
      return getEventsInRange(payload);
    },
  }) as unknown as BackendClient;

const busyEvent = (startIso: string, endIso: string) =>
  new EventRecord({
    accountId: 'a',
    calendarId: 'c',
    endUtc: Date.parse(endIso),
    etag: null,
    id: startIso,
    isAllDay: false,
    startUtc: Date.parse(startIso),
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: 'busy',
    updatedAt: 0,
  });

describe('makeFindSlots', () => {
  it('passes parse rejections through as reasons', async () => {
    const find = makeFindSlots(
      model({}),
      backendWith(() => Effect.succeed([])),
      TZ,
    );
    const result = await find('sometime');
    expect(result).toHaveProperty('reason');
  });

  it('solves over the fetched window and carries the title', async () => {
    const find = makeFindSlots(
      model({
        durationMinutes: 60,
        title: 'focus',
        windowEndDate: '2026-08-25',
        windowStartDate: '2026-08-25',
      }),
      backendWith(() =>
        Effect.succeed([busyEvent('2026-08-25T06:00:00Z', '2026-08-25T09:00:00Z')]),
      ),
      TZ,
    );
    const result = await find('an hour tomorrow');
    if ('reason' in result) {
      throw new Error(result.reason);
    }
    expect(result.title).toBe('focus');
    // Vienna is UTC+2: busy 08:00–11:00 local, so the first slot is 11:00.
    expect(result.slots[0]).toMatchObject({ date: '2026-08-25', startTime: '11:00' });
  });

  it('pads the fetch window a day past the local date bounds', async () => {
    const calls: Array<{ rangeEndUtc: number; rangeStartUtc: number }> = [];
    const find = makeFindSlots(
      model({ durationMinutes: 60, windowEndDate: '2026-08-26', windowStartDate: '2026-08-25' }),
      backendWith(() => Effect.succeed([]), calls),
      TZ,
    );
    await find('an hour');
    const day = 24 * 60 * 60 * 1000;
    expect(calls[0]?.rangeStartUtc).toBe(plainDateToUtcMs('2026-08-25') - day);
    expect(calls[0]?.rangeEndUtc).toBe(plainDateToUtcMs('2026-08-26') + 2 * day);
  });

  it('maps a backend failure to a human reason, not a crash', async () => {
    const find = makeFindSlots(
      model({ durationMinutes: 60 }),
      backendWith(() => Effect.fail(new Error('db locked')) as never),
      TZ,
    );
    const result = await find('an hour');
    expect(result).toEqual({ reason: "Couldn't load your calendar — try again." });
  });
});
