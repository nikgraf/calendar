import type { LanguageModel } from './model.ts';
import { EventRecord, plainDateToUtcMs, Temporal, type BackendClient } from '@calendar/core';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { makeFindSlots } from './findTimePipeline.ts';

const TZ = 'Europe/Vienna';

// The pipeline bakes nowUtc = Date.now(), so fixed test dates DECAY: the
// original 2026-08-25 window fell into the past a day after this file was
// written and broke main's gate. Everything is tomorrow-relative now, and
// busy times are built from Vienna WALL CLOCK (not UTC-offset literals),
// so the assertions also survive DST flips.
const tomorrow = Temporal.Now.plainDateISO(TZ).add({ days: 1 });
const dayAfter = tomorrow.add({ days: 1 });
const atWallClock = (date: Temporal.PlainDate, hour: number): number =>
  date.toZonedDateTime({ plainTime: new Temporal.PlainTime(hour, 0), timeZone: TZ }).toInstant()
    .epochMilliseconds;

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

const busyEvent = (startUtc: number, endUtc: number) =>
  new EventRecord({
    accountId: 'a',
    calendarId: 'c',
    endUtc,
    etag: null,
    id: `${startUtc}`,
    isAllDay: false,
    startUtc,
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: 'busy',
    updatedAt: 0,
  });

describe('makeFindSlots (shared pipeline)', () => {
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
        windowEndDate: tomorrow.toString(),
        windowStartDate: tomorrow.toString(),
      }),
      backendWith(() =>
        // Busy 08:00–11:00 Vienna wall clock tomorrow.
        Effect.succeed([busyEvent(atWallClock(tomorrow, 8), atWallClock(tomorrow, 11))]),
      ),
      TZ,
    );
    const result = await find('an hour tomorrow');
    if ('reason' in result) {
      throw new Error(result.reason);
    }
    expect(result.title).toBe('focus');
    expect(result.slots[0]).toMatchObject({ date: tomorrow.toString(), startTime: '11:00' });
  });

  it('pads the fetch window a day past the local date bounds', async () => {
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
