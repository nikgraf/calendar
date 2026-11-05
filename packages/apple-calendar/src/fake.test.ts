import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
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
/** What EventKit calls the occurrence of 'ek-series' it detached at `slot`. */
const own = (slot: number) => `ek-series/RID=${slot / 1000 - 978_307_200}`;
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe('fake EventKit batches and calendars', () => {
  it('applies a batch write by write and reports the ones it could not make', async () => {
    const { client, state } = setup();
    const single = await run(
      client.create({
        calendarId: 'cal-home',
        event: { endUtc: first + HOUR, startUtc: first, title: 'Single' },
      }),
    );
    // Both ids exist; only the external one is the same on every device.
    expect(single.externalId).toBe(`ext-${single.id}`);
    const failures = await run(
      client.applyBatch({
        ops: [
          {
            calendarId: 'cal-home',
            event: {
              endUtc: first + 2 * HOUR,
              startUtc: first + HOUR,
              title: 'Created',
              url: 'x-solunivo-mirror:abc',
            },
            kind: 'create',
          },
          { changes: { location: null, title: 'Renamed' }, kind: 'update', ref: { id: single.id } },
          { kind: 'delete', ref: { id: 'ek-nope' } },
          { calendarId: 'cal-nope', event: { title: 'Lost' }, kind: 'create' },
        ],
      }),
    );
    expect(failures.map((failure) => failure.index)).toEqual([2, 3]);
    expect(failures[0]?.message).toContain('notFound');
    const titles = [...state.series.values()].map((series) => series.event.title).sort();
    expect(titles).toEqual(['Created', 'Renamed', 'Standup']);
  });

  it('refuses a batch above the cap', async () => {
    const { client } = setup();
    const ops = Array.from({ length: 201 }, () => ({
      kind: 'delete' as const,
      ref: { id: 'ek-nope' },
    }));
    const error = await run(Effect.flip(client.applyBatch({ ops })));
    expect(error._tag).toBe('AppleCalendarRequestError');
  });

  it('creates a writable calendar in a CalDAV account', async () => {
    const { client } = setup();
    const created = await run(client.createCalendar({ title: 'Availability' }));
    expect(created).toMatchObject({
      allowsModifications: true,
      sourceType: 'calDAV',
      title: 'Availability',
    });
    const listed = await run(client.listCalendars());
    expect(listed.map((calendar) => calendar.title)).toContain('Availability');
  });
});

describe('fake EventKit spans', () => {
  it('expands a series into occurrences named by their slot', async () => {
    const { client } = setup();
    const events = await run(client.events(window));
    expect(events.map((e) => e.occurrenceStartUtc)).toEqual(
      [0, 1, 2, 3].map((w) => first + w * 7 * DAY),
    );
  });

  it('thisEvent detaches one occurrence and keeps its slot', async () => {
    const { bridge, client } = setup();
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
    // Every occurrence is the series', by its id and slot …
    expect(new Set(events.map((e) => e.id))).toEqual(new Set(['ek-series']));
    // … while EventKit itself names the changed one by an id of its own.
    expect((await run(bridge.events(window))).map((e) => e.id)).toEqual([
      'ek-series',
      own(slot),
      'ek-series',
      'ek-series',
    ]);
    expect((await run(bridge.series({ id: own(slot) }))).first).toMatchObject({
      hasRecurrence: false,
      isDetached: true,
      occurrenceStartUtc: slot,
      startUtc: slot + 2 * HOUR,
    });
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

  it('finds an occurrence by slot the way the bridge does: its own id exactly, 31 days either side', async () => {
    const { bridge, state } = setup();
    const near = first + 7 * DAY;
    const far = first + 14 * DAY;
    const moveTo = (id: string, slot: number, days: number) =>
      bridge.update({
        changes: { endUtc: slot + days * DAY + HOUR, startUtc: slot + days * DAY },
        ref: { id, originalStartUtc: slot },
        span: 'thisEvent',
      });
    await run(moveTo('ek-series', near, 30));
    await run(moveTo('ek-series', far, 40));
    // A range read returns both, wherever they sit now.
    const moved = (await run(bridge.events({ endUtc: first + 100 * DAY, startUtc: first - DAY })))
      .filter((e) => e.isDetached)
      .map((e) => e.occurrenceStartUtc);
    expect(moved).toEqual([near, far]);
    // The series id no longer names either slot …
    for (const slot of [near, far]) {
      expect(await run(Effect.flip(moveTo('ek-series', slot, 1)))).toMatchObject({
        message: `notFound: occurrence ek-series@${slot}`,
      });
    }
    // … the occurrence's own id with its slot finds the one 30 days off, not the one 40 days off,
    await run(moveTo(own(near), near, 29));
    const farRef = { id: own(far), originalStartUtc: far };
    const notFound = {
      _tag: 'AppleCalendarRequestError',
      message: `notFound: occurrence ${own(far)}@${far}`,
    };
    for (const span of ['thisEvent', 'futureEvents'] as const) {
      expect(await run(Effect.flip(bridge.delete({ ref: farRef, span })))).toMatchObject(notFound);
      expect(
        await run(Effect.flip(bridge.update({ changes: { title: 'x' }, ref: farRef, span }))),
      ).toMatchObject(notFound);
    }
    // … and its own id alone finds it at any distance.
    await run(
      bridge.update({ changes: { title: 'Far' }, ref: { id: own(far) }, span: 'thisEvent' }),
    );
    expect(state.series.get('ek-series')?.detached.get(far)?.title).toBe('Far');
    expect(state.series.size).toBe(1);
    await run(bridge.delete({ ref: { id: own(far) }, span: 'thisEvent' }));
    expect(state.series.get('ek-series')?.deleted.has(far)).toBe(true);
  });

  it('answers the series by its id although the first occurrence was changed or deleted', async () => {
    const { bridge, state } = setup();
    await run(
      bridge.update({
        changes: { title: 'Kickoff' },
        ref: { id: 'ek-series', originalStartUtc: first },
        span: 'thisEvent',
      }),
    );
    expect(await run(bridge.series({ id: 'ek-series' }))).toMatchObject({
      first: { isDetached: false, occurrenceStartUtc: first, title: 'Standup' },
      rules: [{ count: 4, freq: 'weekly' }],
    });
    // A write to the series reaches the occurrences it draws; the changed
    // one keeps what it changed and takes the rest.
    await run(
      bridge.update({
        changes: { location: 'Room 2', title: 'Daily' },
        ref: { id: 'ek-series' },
        span: 'futureEvents',
      }),
    );
    expect(
      (await run(bridge.events(window))).map((e) => [e.title, e.location, e.isDetached]),
    ).toEqual([
      ['Kickoff', 'Room 2', true],
      ['Daily', 'Room 2', false],
      ['Daily', 'Room 2', false],
      ['Daily', 'Room 2', false],
    ]);
    // A time change moves every slot; the identifier keeps the old one.
    await run(
      bridge.update({
        changes: { endUtc: first + 2 * HOUR, startUtc: first + HOUR },
        ref: { id: 'ek-series' },
        span: 'futureEvents',
      }),
    );
    const kickoff = state.series.get('ek-series')?.detached.get(first + HOUR);
    expect(kickoff).toMatchObject({
      id: `ek-series/RID=${first / 1000 - 978_307_200}`,
      occurrenceStartUtc: first + HOUR,
      startUtc: first + HOUR,
    });
    await run(bridge.delete({ ref: { id: 'ek-series' }, span: 'futureEvents' }));
    expect(await run(bridge.events(window))).toEqual([]);
  });

  it('futureEvents on a changed first occurrence writes the series in place', async () => {
    const { bridge, state } = setup();
    await run(
      bridge.update({
        changes: { title: 'Kickoff' },
        ref: { id: 'ek-series', originalStartUtc: first },
        span: 'thisEvent',
      }),
    );
    const saved = await run(
      bridge.update({
        changes: { endUtc: first + 2 * HOUR, startUtc: first + HOUR, title: 'Kickoff, later' },
        ref: { id: own(first) },
        span: 'futureEvents',
      }),
    );
    // Still the one series, an hour later; the first stays changed, under
    // the identifier it got when it was detached.
    expect(state.series.size).toBe(1);
    expect(saved).toMatchObject({
      id: own(first),
      isDetached: true,
      occurrenceStartUtc: first + HOUR,
      startUtc: first + HOUR,
      title: 'Kickoff, later',
    });
    expect(
      (await run(bridge.events(window))).map((e) => [e.id, e.title, e.startUtc - first]),
    ).toEqual([
      [own(first), 'Kickoff, later', HOUR],
      ['ek-series', 'Kickoff, later', 7 * DAY + HOUR],
      ['ek-series', 'Kickoff, later', 14 * DAY + HOUR],
      ['ek-series', 'Kickoff, later', 21 * DAY + HOUR],
    ]);
  });

  it('futureEvents on a changed occurrence splits the series at its slot and keeps it changed', async () => {
    const { bridge, state } = setup();
    const slot = first + 7 * DAY;
    const later = first + 21 * DAY;
    for (const at of [slot, later]) {
      await run(
        bridge.update({
          changes: { endUtc: at + 3 * HOUR, startUtc: at + 2 * HOUR },
          ref: { id: 'ek-series', originalStartUtc: at },
          span: 'thisEvent',
        }),
      );
    }
    const saved = await run(
      bridge.update({ changes: { title: 'v2' }, ref: { id: own(slot) }, span: 'futureEvents' }),
    );
    expect(state.series.size).toBe(2);
    const continued = [...state.series.keys()].find((id) => id !== 'ek-series')!;
    expect(saved).toMatchObject({ id: `${continued}/RID=${slot / 1000 - 978_307_200}` });
    expect(
      (await run(bridge.events(window))).map((e) => [
        e.id,
        e.title,
        e.startUtc - e.occurrenceStartUtc!,
      ]),
    ).toEqual([
      ['ek-series', 'Standup', 0],
      [`${continued}/RID=${slot / 1000 - 978_307_200}`, 'v2', 2 * HOUR],
      [continued, 'v2', 0],
      // The later changed occurrence comes along as it was.
      [`${continued}/RID=${later / 1000 - 978_307_200}`, 'Standup', 2 * HOUR],
    ]);
    // Removing from a changed occurrence on cuts the series at its slot.
    await run(
      bridge.delete({
        ref: { id: `${continued}/RID=${later / 1000 - 978_307_200}` },
        span: 'futureEvents',
      }),
    );
    expect((await run(bridge.events(window))).map((e) => e.occurrenceStartUtc)).toEqual([
      first,
      slot,
      first + 14 * DAY,
    ]);
  });

  it('a split that changes the time takes the later changed occurrences along', async () => {
    const { bridge, state } = setup();
    const slot = first + 7 * DAY;
    const later = first + 21 * DAY;
    await run(
      bridge.update({
        changes: { title: 'Retro' },
        ref: { id: 'ek-series', originalStartUtc: later },
        span: 'thisEvent',
      }),
    );
    await run(
      bridge.update({
        changes: { endUtc: slot + 3 * HOUR, startUtc: slot + 2 * HOUR },
        ref: { id: 'ek-series', originalStartUtc: slot },
        span: 'futureEvents',
      }),
    );
    const continued = [...state.series.keys()].find((id) => id !== 'ek-series')!;
    // No slot is drawn twice: the renamed one moved with its series.
    expect(
      (await run(bridge.events(window))).map((e) => [e.title, e.startUtc - first, e.isDetached]),
    ).toEqual([
      ['Standup', 0, false],
      ['Standup', 7 * DAY + 2 * HOUR, false],
      ['Standup', 14 * DAY + 2 * HOUR, false],
      ['Retro', 21 * DAY + 2 * HOUR, true],
    ]);
    expect(state.series.get(continued)?.detached.get(later + 2 * HOUR)).toMatchObject({
      id: `${continued}/RID=${later / 1000 - 978_307_200}`,
      occurrenceStartUtc: later + 2 * HOUR,
    });
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
