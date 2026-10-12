import { EventRecord, Temporal, type BackendClient } from '@calendar/core';
import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import type { LanguageModel } from './model.ts';
import {
  isFinderPhrase,
  MAX_SLOT_PROPOSALS,
  NO_SLOT_FITS,
  proposalCentre,
  proposeSlots,
} from './slotProposals.ts';

const TZ = 'Europe/Vienna';

// Tomorrow-relative, Vienna wall clock: the pipeline bakes in Date.now(),
// so pinned dates would decay and offset literals would break at DST.
const tomorrow = Temporal.Now.plainDateISO(TZ).add({ days: 1 });
const at = (date: Temporal.PlainDate, hour: number, minute = 0): number =>
  date
    .toZonedDateTime({ plainTime: new Temporal.PlainTime(hour, minute), timeZone: TZ })
    .toInstant().epochMilliseconds;

const model = (parse: unknown): LanguageModel => ({
  generateJson: async () => parse,
  status: async () => 'ready',
});

const backendWith = (events: ReadonlyArray<EventRecord> | Error): BackendClient =>
  ({
    getEventsInRange: () =>
      events instanceof Error ? (Effect.fail(events) as never) : Effect.succeed(events),
  }) as unknown as BackendClient;

const busy = (startUtc: number, endUtc: number) =>
  new EventRecord({
    accountId: 'a',
    calendarId: 'c',
    endUtc,
    etag: null,
    id: `${String(startUtc)}`,
    isAllDay: false,
    startUtc,
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: 'busy',
    updatedAt: 0,
  });

const context = { referenceDate: Temporal.Now.plainDateISO(TZ).toString(), timeZone: TZ };

describe('isFinderPhrase', () => {
  it.each([
    'find 90 min for focus next week, mornings',
    'Find a slot for lunch with Sarah this week',
    'find time for a 1:1 with Teo',
    'find me an hour tomorrow',
    'when can I fit a 1h call with Anna this week?',
    'When could we meet next week',
    'when do I have time for a haircut',
    'when am I free on Thursday',
    'a free slot tomorrow morning',
    'free time next week for a review',
    'fit in a 30 min walk tomorrow',
    'fit a dentist visit in next week',
    'sometime next week, 2h for the report',
    'any openings for a call tomorrow afternoon',
    'look for a free hour on Friday',
    'where can I fit 45 min of yoga',
    'find 30 min tomorrow morning | Focus',
    'find 1h for yoga tomorrow',
    'find 90min for focus next week',
    'finde 2h für den Bericht',
    'finde 90 Minuten für Fokus nächste Woche',
    'Finde einen Termin für Mittagessen mit Sarah',
    'wann habe ich Zeit für einen Haarschnitt',
    'wann hab ich eine Stunde frei',
    'wann kann ich eine Stunde laufen gehen',
    'wann passt ein Call mit Anna',
    'freie Zeit nächste Woche für die Review',
    'ein freier Slot morgen Vormittag',
    'eine Lücke für 30 Minuten Spaziergang',
    'irgendwann nächste Woche 2 Stunden für den Bericht',
    'Zeit finden für Yoga',
    'wo passt eine Stunde Yoga rein',
  ])('asks for free time: %s', (phrase) => {
    expect(isFinderPhrase(phrase)).toBe(true);
  });

  it.each([
    'Dinner with Teo tomorrow at 7',
    'Free lunch at the office Friday',
    'Fitness class Tuesdays at 7',
    'Finders Keepers screening Saturday',
    'Call with Anna when she lands',
    'Freediving course next week',
    'Open house Sunday 2pm',
    'Opening night of the play',
    'Grand opening Saturday 10am',
    'Lunch | +2 | 12:00-13:00',
    '| | 20:00-21:00',
    'Thursday instead',
    'Abendessen mit Teo morgen um 7',
    'Freibad mit den Kindern Samstag',
    'Anna fragen wann sie kommt',
    'call it Free time',
    'rename it to find a slot',
    'nenn es Freie Zeit',
  ])('names an event or a change: %s', (phrase) => {
    expect(isFinderPhrase(phrase)).toBe(false);
  });
});

describe('proposalCentre', () => {
  it('is the middle of the named period’s bounds, to the quarter hour', () => {
    expect(
      proposalCentre('mornings next week', { earliestTime: '08:00', latestTime: '12:00' }),
    ).toBe('10:00');
    expect(proposalCentre('lunch this week', { earliestTime: '11:30', latestTime: '14:00' })).toBe(
      '12:45',
    );
  });

  it('follows the bounds the finder settled on when the period is a boundary', () => {
    expect(proposalCentre('after dinner', { earliestTime: '21:00', latestTime: '23:00' })).toBe(
      '22:00',
    );
  });

  it('falls back to the daytime bounds when the finder set none', () => {
    expect(proposalCentre('tonight', {})).toBe('14:00');
  });

  it('is nothing without a named period', () => {
    expect(proposalCentre('an hour tomorrow', { earliestTime: '08:00', latestTime: '12:00' })).toBe(
      undefined,
    );
  });
});

describe('proposeSlots', () => {
  // Busy 08:45–09:15 and 10:15–10:45: three gaps in the morning.
  const morning = backendWith([
    busy(at(tomorrow, 8, 45), at(tomorrow, 9, 15)),
    busy(at(tomorrow, 10, 15), at(tomorrow, 10, 45)),
  ]);

  it('places each gap’s slot at the named time of day and ranks the nearest first, the title along', async () => {
    const result = await proposeSlots(model({ durationMinutes: 60, title: 'Focus' }), morning, {
      ...context,
      phrase: 'find 30 min tomorrow morning',
    });
    expect(result).toEqual({
      kind: 'proposed',
      slots: [
        { date: tomorrow.toString(), endTime: '10:15', startTime: '09:45' },
        { date: tomorrow.toString(), endTime: '11:15', startTime: '10:45' },
        { date: tomorrow.toString(), endTime: '08:45', startTime: '08:15' },
      ],
      title: 'Focus',
    });
  });

  it('searches for the fallback length when the phrase states none, soonest first without a period', async () => {
    const result = await proposeSlots(model({ durationMinutes: 240 }), morning, {
      ...context,
      fallbackDurationMinutes: 45,
      phrase: 'find a slot tomorrow',
    });
    if (result.kind !== 'proposed') {
      throw new Error(result.reason);
    }
    // The 08:00–08:45 gap holds 45 minutes at its start; 09:15–10:15 next.
    expect(result.slots.slice(0, 2)).toEqual([
      { date: tomorrow.toString(), endTime: '08:45', startTime: '08:00' },
      { date: tomorrow.toString(), endTime: '10:00', startTime: '09:15' },
    ]);
    expect(result.slots.length).toBeLessThanOrEqual(MAX_SLOT_PROPOSALS);
  });

  it('says so when nothing fits', async () => {
    const result = await proposeSlots(model({ durationMinutes: 60 }), morning, {
      ...context,
      phrase: 'find 3 hours tomorrow morning',
    });
    expect(result).toEqual({ kind: 'rejected', reason: NO_SLOT_FITS });
  });

  it('passes the finder’s own rejection through', async () => {
    const result = await proposeSlots(model({}), morning, { ...context, phrase: 'sometime' });
    expect(result).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('how long') });
  });

  it('turns a failed event read into a reason', async () => {
    const result = await proposeSlots(
      model({ durationMinutes: 60 }),
      backendWith(new Error('db locked')),
      { ...context, phrase: 'find an hour tomorrow' },
    );
    expect(result).toEqual({
      kind: 'rejected',
      reason: "Couldn't load your calendar — try again.",
    });
  });
});
