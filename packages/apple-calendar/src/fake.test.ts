import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { makeFakeAppleCalendarClient } from './fake.ts';
import type { AppleEventJson } from './protocol.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const first = Date.UTC(2026, 6, 6, 9); // a Monday, 09:00 UTC

const weekly = (): AppleEventJson => ({
  calendarId: 'cal-home',
  endUtc: first + HOUR,
  hasRecurrence: true,
  id: 'ek-series',
  isAllDay: false,
  isDetached: false,
  occurrenceStartUtc: first,
  startUtc: first,
  status: 'confirmed',
  timeZone: 'UTC',
  title: 'Standup',
  updatedAt: 1,
});

const setup = () =>
  makeFakeAppleCalendarClient({
    calendars: [
      {
        allowsModifications: true,
        id: 'cal-home',
        isDefault: true,
        sourceTitle: 'iCloud',
        sourceType: 'calDAV',
        title: 'Home',
        type: 'calDAV',
      },
      {
        allowsModifications: true,
        id: 'cal-work',
        isDefault: false,
        sourceTitle: 'iCloud',
        sourceType: 'calDAV',
        title: 'Work',
        type: 'calDAV',
      },
    ],
    events: [{ event: weekly(), recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'] }],
  });

const window = { endUtc: first + 5 * 7 * DAY, startUtc: first - DAY };
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe('fake EventKit spans', () => {
  it('expands a series into occurrences named by their slot', async () => {
    const { client } = setup();
    const events = await run(client.events(window));
    expect(events.map((e) => e.occurrenceStartUtc)).toEqual(
      [0, 1, 2, 3].map((w) => first + w * 7 * DAY),
    );
  });

  it('thisEvent detaches one occurrence and keeps its slot', async () => {
    const { client } = setup();
    const slot = first + 7 * DAY;
    await run(
      client.update({
        changes: { endUtc: slot + 3 * HOUR, startUtc: slot + 2 * HOUR },
        ref: { id: 'ek-series', originalStartUtc: slot },
        span: 'thisEvent',
      }),
    );
    const events = await run(client.events(window));
    const moved = events.find((e) => e.occurrenceStartUtc === slot);
    expect(moved?.startUtc).toBe(slot + 2 * HOUR);
    expect(moved?.isDetached).toBe(true);
    expect(events).toHaveLength(4);
    expect((await run(client.series({ id: 'ek-series' }))).detachedCount).toBe(1);
  });

  it('futureEvents from a later occurrence splits the series', async () => {
    const { client, state } = setup();
    const slot = first + 14 * DAY;
    await run(
      client.update({
        changes: { title: 'Standup v2' },
        ref: { id: 'ek-series', originalStartUtc: slot },
        span: 'futureEvents',
      }),
    );
    const titles = (await run(client.events(window))).map((e) => e.title);
    expect(titles).toEqual(['Standup', 'Standup', 'Standup v2', 'Standup v2']);
    expect(state.series.size).toBe(2);
  });

  it('futureEvents on the first occurrence rewrites the whole series', async () => {
    const { client, state } = setup();
    await run(
      client.update({
        changes: { title: 'Renamed' },
        ref: { id: 'ek-series', originalStartUtc: first },
        span: 'futureEvents',
      }),
    );
    expect(new Set((await run(client.events(window))).map((e) => e.title))).toEqual(
      new Set(['Renamed']),
    );
    expect(state.series.size).toBe(1);
  });

  it('deletes one occurrence or the rest of the series', async () => {
    const { client } = setup();
    await run(
      client.delete({
        ref: { id: 'ek-series', originalStartUtc: first + 7 * DAY },
        span: 'thisEvent',
      }),
    );
    expect(await run(client.events(window))).toHaveLength(3);
    await run(
      client.delete({
        ref: { id: 'ek-series', originalStartUtc: first + 14 * DAY },
        span: 'futureEvents',
      }),
    );
    expect(await run(client.events(window))).toHaveLength(1);
  });

  it('moves a whole series to another calendar', async () => {
    const { client } = setup();
    await run(client.move({ calendarId: 'cal-work', id: 'ek-series' }));
    expect(new Set((await run(client.events(window))).map((e) => e.calendarId))).toEqual(
      new Set(['cal-work']),
    );
  });

  it('reports access loss as the typed error', async () => {
    const { client, state } = setup();
    state.authorization = 'denied';
    const error = await run(Effect.flip(client.events(window)));
    expect(error._tag).toBe('AppleCalendarAccessError');
  });
});
