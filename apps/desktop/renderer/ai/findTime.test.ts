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

describe('desktop makeFindSlots', () => {
  it('solves over the fetched window', async () => {
    const busy = new EventRecord({
      accountId: 'a',
      calendarId: 'c',
      endUtc: Date.parse('2026-08-26T09:00:00Z'),
      etag: null,
      id: 'e1',
      isAllDay: false,
      startUtc: Date.parse('2026-08-26T06:00:00Z'),
      status: 'confirmed',
      syncedAt: 0,
      syncStatus: 'synced',
      title: 'busy',
      updatedAt: 0,
    });
    const find = makeFindSlots(
      model({ durationMinutes: 60, windowEndDate: '2026-08-26', windowStartDate: '2026-08-26' }),
      backendWith(() => Effect.succeed([busy])),
      TZ,
    );
    const result = await find('an hour');
    if ('reason' in result) {
      throw new Error(result.reason);
    }
    // Vienna is UTC+2: busy 08:00–11:00 local → first slot 11:00.
    expect(result.slots[0]).toMatchObject({ date: '2026-08-26', startTime: '11:00' });
  });

  it('pads the fetch window and maps backend failures to reasons', async () => {
    const calls: Array<{ rangeEndUtc: number; rangeStartUtc: number }> = [];
    const find = makeFindSlots(
      model({ durationMinutes: 60, windowEndDate: '2026-08-27', windowStartDate: '2026-08-26' }),
      backendWith(() => Effect.succeed([]), calls),
      TZ,
    );
    await find('an hour');
    const day = 24 * 60 * 60 * 1000;
    expect(calls[0]?.rangeStartUtc).toBe(plainDateToUtcMs('2026-08-26') - day);
    expect(calls[0]?.rangeEndUtc).toBe(plainDateToUtcMs('2026-08-27') + 2 * day);

    const failing = makeFindSlots(
      model({ durationMinutes: 60 }),
      backendWith(() => Effect.fail(new Error('rpc down')) as never),
      TZ,
    );
    expect(await failing('an hour')).toEqual({
      reason: "Couldn't load your calendar — try again.",
    });
  });
});
