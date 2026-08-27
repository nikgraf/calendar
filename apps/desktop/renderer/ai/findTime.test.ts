import type { LanguageModel } from '@calendar/ai';
import { EventRecord, plainDateToUtcMs, Temporal, type BackendClient } from '@calendar/core';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { makeFindSlots } from './findTime.ts';

const TZ = 'Europe/Vienna';

// Tomorrow-relative, wall-clock-built: the pipeline bakes nowUtc =
// Date.now(), so fixed dates decay (the iOS twin of this file broke
// main's gate one day after it was written).
const tomorrow = Temporal.Now.plainDateISO(TZ).add({ days: 1 });
const dayAfter = tomorrow.add({ days: 1 });
const atWallClock = (date: Temporal.PlainDate, hour: number): number =>
  date.toZonedDateTime({ plainTime: new Temporal.PlainTime(hour, 0), timeZone: TZ }).toInstant()
    .epochMilliseconds;

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
    // Busy 08:00–11:00 Vienna wall clock tomorrow.
    const busy = new EventRecord({
      accountId: 'a',
      calendarId: 'c',
      endUtc: atWallClock(tomorrow, 11),
      etag: null,
      id: 'e1',
      isAllDay: false,
      startUtc: atWallClock(tomorrow, 8),
      status: 'confirmed',
      syncedAt: 0,
      syncStatus: 'synced',
      title: 'busy',
      updatedAt: 0,
    });
    const find = makeFindSlots(
      model({
        durationMinutes: 60,
        windowEndDate: tomorrow.toString(),
        windowStartDate: tomorrow.toString(),
      }),
      backendWith(() => Effect.succeed([busy])),
      TZ,
    );
    const result = await find('an hour');
    if ('reason' in result) {
      throw new Error(result.reason);
    }
    expect(result.slots[0]).toMatchObject({ date: tomorrow.toString(), startTime: '11:00' });
  });

  it('pads the fetch window and maps backend failures to reasons', async () => {
    const calls: Array<{ rangeEndUtc: number; rangeStartUtc: number }> = [];
    const find = makeFindSlots(
      model({
        durationMinutes: 60,
        windowEndDate: dayAfter.toString(),
        windowStartDate: tomorrow.toString(),
      }),
      backendWith(() => Effect.succeed([]), calls),
      TZ,
    );
    await find('an hour');
    const day = 24 * 60 * 60 * 1000;
    expect(calls[0]?.rangeStartUtc).toBe(plainDateToUtcMs(tomorrow.toString()) - day);
    expect(calls[0]?.rangeEndUtc).toBe(plainDateToUtcMs(dayAfter.toString()) + 2 * day);

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
