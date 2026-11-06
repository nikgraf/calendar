import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import type { AppleCalendarBridgeShape } from './client.ts';
import { AppleCalendarRequestError } from './errors.ts';
import { makeFakeAppleCalendarClient } from './fake.ts';
import { appleDetachedId, appleDetachedIdGuesses, appleSeriesId } from './identity.ts';
import type { AppleEventJson, OccurrenceRef } from './protocol.ts';
import { withSeriesIdentity } from './seriesIdentity.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const first = Date.UTC(2026, 6, 6, 9); // a Monday, 09:00 UTC
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const weekly = (overrides: Partial<AppleEventJson> = {}): AppleEventJson => ({
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
  ...overrides,
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
    ],
    events: [{ event: weekly(), recurrence: ['RRULE:FREQ=WEEKLY;COUNT=6'] }],
  });

const missing = (id: string) =>
  Effect.fail(new AppleCalendarRequestError({ message: `notFound: event ${id}`, method: 'x' }));

const slot = first + 7 * DAY;
const bySlot = { id: 'ek-series', originalStartUtc: slot };

describe('appleSeriesId', () => {
  it("is what precedes /RID= in an occurrence's own identifier", () => {
    const series = '7E805DB7-E94F:7B3F4366-5361';
    expect(appleSeriesId(series)).toBe(series);
    expect(appleSeriesId(`${series}/RID=821959200`)).toBe(series);
    expect(appleSeriesId(`${series}/RID=-3600`)).toBe(series);
    // Only a trailing /RID=<number> is EventKit's.
    expect(appleSeriesId('uid/RID=abc')).toBe('uid/RID=abc');
    expect(appleSeriesId('uid/RID=12/x')).toBe('uid/RID=12/x');
  });

  it('guesses the identifier from the slot: as an instant, and as a wall clock', () => {
    // 2027-02-15T00:00 in Vienna = 2027-02-14T23:00Z; EventKit names an
    // all-day or floating occurrence by its wall clock read as UTC.
    const midnight = Date.UTC(2027, 1, 14, 23);
    expect(appleDetachedIdGuesses('S', midnight, 'Europe/Vienna')).toEqual([
      'S/RID=824338800',
      'S/RID=824342400',
    ]);
    expect(appleDetachedIdGuesses('S', midnight, 'UTC')).toEqual(['S/RID=824338800']);
    expect(appleDetachedId('S', Date.UTC(2027, 0, 18, 10))).toBe('S/RID=821959200');
  });
});

describe('withSeriesIdentity', () => {
  it('names a changed occurrence by its series in every read', async () => {
    const { bridge, client } = setup();
    const saved = await run(
      client.update({ changes: { title: 'Late' }, ref: bySlot, span: 'thisEvent' }),
    );
    expect(saved).toMatchObject({ id: 'ek-series', isDetached: true, occurrenceStartUtc: slot });
    const window = { endUtc: first + 60 * DAY, startUtc: first - DAY };
    expect(new Set((await run(client.events(window))).map((event) => event.id))).toEqual(
      new Set(['ek-series']),
    );
    expect((await run(bridge.events(window))).filter((event) => event.isDetached)).toMatchObject([
      { id: appleDetachedId('ek-series', slot) },
    ]);
    expect(await run(client.occurrence(bySlot))).toMatchObject({ id: 'ek-series', title: 'Late' });
    // The series itself is read by its id, the changed occurrence aside.
    expect(await run(client.series({ id: 'ek-series' }))).toMatchObject({
      first: { id: 'ek-series', occurrenceStartUtc: first, title: 'Standup' },
      rules: [{ count: 6 }],
    });
  });

  it('writes a changed occurrence by its slot at any distance, a drawn one in one call', async () => {
    const { client, state } = setup();
    const calls = () => state.calls.splice(0);
    await run(client.update({ changes: { title: 'Drawn' }, ref: bySlot, span: 'thisEvent' }));
    // The bridge finds what the rule draws by itself.
    expect(calls()).toEqual(['update']);
    await run(
      client.update({
        changes: { endUtc: slot + 90 * DAY + HOUR, startUtc: slot + 90 * DAY },
        ref: bySlot,
        span: 'thisEvent',
      }),
    );
    // It has nothing under the series id there: the occurrence is read by
    // its guessed identifier, then written by it.
    expect(calls()).toEqual(['update', 'series', 'update']);
    expect(await run(client.occurrence(bySlot))).toMatchObject({ startUtc: slot + 90 * DAY });
    await run(client.delete({ ref: bySlot, span: 'thisEvent' }));
    expect(state.series.get('ek-series')?.deleted.has(slot)).toBe(true);
    expect(await run(client.occurrence(bySlot))).toBeUndefined();
    // Gone: the bridge's own answer.
    const gone = await run(Effect.flip(client.delete({ ref: bySlot, span: 'thisEvent' })));
    expect(gone).toMatchObject({ message: `notFound: occurrence ek-series@${slot}` });
  });

  it('takes an occurrence ref that still carries the own identifier', async () => {
    const { client, state } = setup();
    await run(client.update({ changes: { title: 'Late' }, ref: bySlot, span: 'thisEvent' }));
    const stale = { id: appleDetachedId('ek-series', slot), originalStartUtc: slot };
    expect(await run(client.occurrence(stale))).toMatchObject({ id: 'ek-series', title: 'Late' });
    await run(client.update({ changes: { title: 'Later' }, ref: stale, span: 'thisEvent' }));
    expect(state.series.get('ek-series')?.detached.get(slot)?.title).toBe('Later');
    // … and names the drawn occurrence when nothing was changed there.
    const other = first + 14 * DAY;
    await run(
      client.delete({
        ref: { id: appleDetachedId('ek-series', other), originalStartUtc: other },
        span: 'thisEvent',
      }),
    );
    expect(state.series.get('ek-series')?.deleted.has(other)).toBe(true);
  });

  it('checks a guessed identifier against what it answers', async () => {
    const { client, state } = setup();
    await run(client.update({ changes: { title: 'Late' }, ref: bySlot, span: 'thisEvent' }));
    // The whole series moves an hour: every slot follows, EventKit's
    // identifier for the changed occurrence keeps the old one.
    await run(
      client.update({
        changes: { endUtc: first + 2 * HOUR, startUtc: first + HOUR },
        ref: { id: 'ek-series' },
        span: 'futureEvents',
      }),
    );
    const series = state.series.get('ek-series')!;
    const moved = slot + HOUR;
    expect(series.detached.get(moved)?.id).toBe(appleDetachedId('ek-series', slot));
    // Its new slot: no identifier guessed from it exists; a read around
    // the slot finds the occurrence, and the write goes by its real one.
    await run(
      client.update({
        changes: { title: 'Found' },
        ref: { id: 'ek-series', originalStartUtc: moved },
        span: 'thisEvent',
      }),
    );
    expect(series.detached.get(moved)?.title).toBe('Found');
    // The identifier a guess from another slot hits belongs to that other
    // occurrence: never written in its place.
    series.detached.set(moved, { ...series.detached.get(moved)!, id: 'ek-series/RID=1' });
    const other = first + 14 * DAY + HOUR;
    await run(
      client.update({
        changes: { title: 'Other' },
        ref: { id: 'ek-series', originalStartUtc: other },
        span: 'thisEvent',
      }),
    );
    series.detached.set(other, {
      ...series.detached.get(other)!,
      endUtc: other + 60 * DAY + HOUR,
      id: appleDetachedId('ek-series', moved),
      startUtc: other + 60 * DAY,
    });
    series.detached.set(moved, {
      ...series.detached.get(moved)!,
      endUtc: moved + 60 * DAY + HOUR,
      startUtc: moved + 60 * DAY,
    });
    expect(await run(client.occurrence({ id: 'ek-series', originalStartUtc: moved }))).toBe(
      undefined,
    );
    const refused = await run(
      Effect.flip(
        client.delete({ ref: { id: 'ek-series', originalStartUtc: moved }, span: 'thisEvent' }),
      ),
    );
    expect(refused).toMatchObject({ message: `notFound: occurrence ek-series@${moved}` });
    expect(series.detached.get(other)?.title).toBe('Other');
    expect(series.detached.size).toBe(2);
  });

  it('finds an all-day occurrence by its wall-clock identifier', async () => {
    // Local midnight in Vienna; EventKit's identifier holds the day as UTC midnight.
    const day = Date.UTC(2027, 1, 14, 23);
    const own = 'ek-days/RID=824342400';
    const changed: AppleEventJson = weekly({
      endDate: '2027-04-02',
      endUtc: day + 46 * DAY,
      hasRecurrence: false,
      id: own,
      isAllDay: true,
      isDetached: true,
      occurrenceStartUtc: day,
      startDate: '2027-04-01',
      startUtc: day + 45 * DAY,
    });
    const asked: Array<string> = [];
    const written: Array<OccurrenceRef> = [];
    const bridge: AppleCalendarBridgeShape = {
      ...setup().bridge,
      delete: ({ ref }) => {
        written.push(ref);
        return ref.id === own && ref.originalStartUtc === undefined ? Effect.void : missing(ref.id);
      },
      events: () => Effect.succeed([]),
      series: ({ id }) => {
        asked.push(id);
        return id === own
          ? Effect.succeed({ detachedCount: 0, first: changed, rules: [] })
          : missing(id);
      },
    };
    const client = withSeriesIdentity(bridge, () => 'Europe/Vienna');
    await run(client.delete({ ref: { id: 'ek-days', originalStartUtc: day }, span: 'thisEvent' }));
    expect(asked).toEqual(['ek-days/RID=824338800', own]);
    expect(written).toEqual([{ id: 'ek-days', originalStartUtc: day }, { id: own }]);
  });

  it("keeps the identifier of an event EventKit does not count as its series' any more", async () => {
    // Seen after a split: the id still ends in /RID=, but the event is not
    // detached, has no slot, and the series draws that day again.
    const orphan = weekly({
      hasRecurrence: false,
      id: 'ek-series/RID=829994400',
      occurrenceStartUtc: undefined,
      title: 'Left over',
    });
    const { bridge, state } = setup();
    const written: Array<OccurrenceRef> = [];
    const client = withSeriesIdentity({
      ...bridge,
      delete: (params) => {
        written.push(params.ref);
        return bridge.delete(params);
      },
      events: (range) => Effect.map(bridge.events(range), (events) => [...events, orphan]),
    });
    const read = await run(client.events({ endUtc: first + DAY, startUtc: first - DAY }));
    expect(read.map((event) => event.id)).toEqual(['ek-series', 'ek-series/RID=829994400']);
    // A delete of it by that id never becomes one of the series.
    await run(Effect.flip(client.delete({ ref: { id: orphan.id }, span: 'thisEvent' })));
    expect(written).toEqual([{ id: 'ek-series/RID=829994400' }]);
    expect(state.series.has('ek-series')).toBe(true);
  });
});
