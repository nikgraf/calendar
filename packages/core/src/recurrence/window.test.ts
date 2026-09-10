import { describe, expect, it } from 'vitest';
import { Temporal } from '../time/temporal.ts';
import { EventRecord } from '../types.ts';
import { assembleWindow } from './window.ts';

const instant = (iso: string): number => Temporal.Instant.from(iso).epochMilliseconds;
const HOUR = 60 * 60 * 1000;

const record = (overrides: Partial<EventRecord>): EventRecord =>
  new EventRecord({
    accountId: 'acc-1',
    calendarId: 'cal-1',
    endUtc: instant('2026-07-07T10:00:00Z'),
    etag: '"e"',
    id: 'evt',
    isAllDay: false,
    startTimeZone: 'UTC',
    startUtc: instant('2026-07-07T09:00:00Z'),
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: 'Standup',
    updatedAt: 0,
    ...overrides,
  });

// Weekly Tuesday 09:00–10:00 UTC from 2026-07-07.
const master = (overrides: Partial<EventRecord> = {}): EventRecord =>
  record({ id: 'master', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'], ...overrides });

const override = (overrides: Partial<EventRecord> = {}): EventRecord =>
  record({
    endUtc: instant('2026-07-14T16:00:00Z'),
    id: 'master_20260714T090000Z',
    originalStartUtc: instant('2026-07-14T09:00:00Z'),
    recurringEventId: 'master',
    startUtc: instant('2026-07-14T15:00:00Z'),
    ...overrides,
  });

const rangeStart = instant('2026-07-06T00:00:00Z');
const rangeEnd = instant('2026-07-27T00:00:00Z');

describe('assembleWindow', () => {
  it('passes singles through and expands masters into materialized instances', () => {
    const single = record({ id: 'single', startUtc: instant('2026-07-20T12:00:00Z') });
    const events = assembleWindow(
      { masters: [master()], overrides: [], singles: [single] },
      rangeStart,
      rangeEnd,
    );

    expect(events.map((event) => event.id)).toEqual([
      `master__${instant('2026-07-07T09:00:00Z')}`,
      `master__${instant('2026-07-14T09:00:00Z')}`,
      'single',
      `master__${instant('2026-07-21T09:00:00Z')}`,
    ]);
    const instance = events[0]!;
    expect(instance.recurringEventId).toBe('master');
    expect(instance.recurrence).toBeUndefined();
    expect(instance.originalStartUtc).toBe(instance.startUtc);
    expect(instance.endUtc - instance.startUtc).toBe(HOUR);
    expect(instance.title).toBe('Standup');
  });

  it('drops the occurrence an override shadows; the override itself arrives as a single', () => {
    const moved = override();
    const events = assembleWindow(
      { masters: [master()], overrides: [moved], singles: [moved] },
      rangeStart,
      rangeEnd,
    );

    expect(events.map((event) => event.id)).toEqual([
      `master__${instant('2026-07-07T09:00:00Z')}`,
      'master_20260714T090000Z',
      `master__${instant('2026-07-21T09:00:00Z')}`,
    ]);
  });

  it('a cancelled override (not among singles) removes the occurrence outright', () => {
    const cancelled = override({ status: 'cancelled' });
    const events = assembleWindow(
      { masters: [master()], overrides: [cancelled], singles: [] },
      rangeStart,
      rangeEnd,
    );

    expect(events.map((event) => event.originalStartUtc)).toEqual([
      instant('2026-07-07T09:00:00Z'),
      instant('2026-07-21T09:00:00Z'),
    ]);
  });

  it("an override of another account's same-id master does not shadow this one", () => {
    // Event ids are Google-global: two accounts on one shared calendar
    // hold masters with the same id. Only acc-2 moved its 14 July
    // occurrence; acc-1 must still render its own.
    const theirs = override({ accountId: 'acc-2' });
    const events = assembleWindow(
      {
        masters: [master(), master({ accountId: 'acc-2' })],
        overrides: [theirs],
        singles: [theirs],
      },
      rangeStart,
      rangeEnd,
    );

    const mine = events.filter((event) => event.accountId === 'acc-1');
    expect(mine.map((event) => event.originalStartUtc)).toEqual([
      instant('2026-07-07T09:00:00Z'),
      instant('2026-07-14T09:00:00Z'),
      instant('2026-07-21T09:00:00Z'),
    ]);
    const other = events.filter((event) => event.accountId === 'acc-2');
    expect(other.map((event) => event.id)).toEqual([
      `master__${instant('2026-07-07T09:00:00Z')}`,
      'master_20260714T090000Z',
      `master__${instant('2026-07-21T09:00:00Z')}`,
    ]);
  });

  it('same-id masters on different calendars of one account are shadowed independently', () => {
    const onOtherCalendar = override({ calendarId: 'cal-2', status: 'cancelled' });
    const events = assembleWindow(
      {
        masters: [master(), master({ calendarId: 'cal-2' })],
        overrides: [onOtherCalendar],
        singles: [],
      },
      rangeStart,
      rangeEnd,
    );

    expect(events.filter((event) => event.calendarId === 'cal-1')).toHaveLength(3);
    expect(events.filter((event) => event.calendarId === 'cal-2')).toHaveLength(2);
  });

  it('clips expansion to the range and skips masters without recurrence lines', () => {
    const events = assembleWindow(
      { masters: [master(), master({ id: 'bare', recurrence: [] })], overrides: [], singles: [] },
      instant('2026-07-13T00:00:00Z'),
      instant('2026-07-20T00:00:00Z'),
    );

    expect(events.map((event) => event.id)).toEqual([`master__${instant('2026-07-14T09:00:00Z')}`]);
  });

  it('sorts the result by start time across singles and instances', () => {
    const early = record({
      endUtc: instant('2026-07-07T08:30:00Z'),
      id: 'early',
      startUtc: instant('2026-07-07T08:00:00Z'),
    });
    const events = assembleWindow(
      { masters: [master()], overrides: [], singles: [early] },
      rangeStart,
      rangeEnd,
    );
    const starts = events.map((event) => event.startUtc);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(events[0]!.id).toBe('early');
  });
});
