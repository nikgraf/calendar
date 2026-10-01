import { plainDateToUtcMs } from '@calendar/core';
import { describe, expect, it } from 'vitest';
import {
  createTimes,
  type ExistingTimes,
  formatDateTime,
  isIsoDate,
  parseDateTime,
  updateTimes,
} from './times.ts';

const HOUR = 3_600_000;
const at = (isoInstant: string): number => Date.parse(isoInstant);

const valueOf = <A>(result: { ok: true; value: A } | { message: string; ok: false }): A => {
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.value;
};

const messageOf = (result: { message?: string; ok: boolean }): string | undefined =>
  result.ok ? undefined : result.message;

describe('parseDateTime / formatDateTime', () => {
  it('an offset or Z is exact; without one the wall clock is read in the zone', () => {
    expect(parseDateTime('2026-10-01T14:00:00+02:00', 'UTC')).toBe(at('2026-10-01T12:00:00Z'));
    expect(parseDateTime('2026-10-01T12:00:00Z', 'Europe/Vienna')).toBe(at('2026-10-01T12:00:00Z'));
    expect(parseDateTime('2026-10-01T14:00', 'Europe/Vienna')).toBe(at('2026-10-01T12:00:00Z'));
    // A bare date is that day's midnight in the zone.
    expect(parseDateTime('2026-10-01', 'Europe/Vienna')).toBe(at('2026-09-30T22:00:00Z'));
    expect(parseDateTime('next tuesday', 'UTC')).toBeUndefined();
  });

  it('formats in the given zone with its offset', () => {
    expect(formatDateTime(at('2026-10-01T12:00:00Z'), 'Europe/Vienna')).toBe(
      '2026-10-01T14:00:00+02:00',
    );
    // After the DST change the same wall clock has another offset.
    expect(formatDateTime(at('2026-11-01T13:00:00Z'), 'Europe/Vienna')).toBe(
      '2026-11-01T14:00:00+01:00',
    );
  });

  it('isIsoDate accepts only real days', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-2-3')).toBe(false);
    expect(isIsoDate('2026-10-01T00:00')).toBe(false);
  });
});

describe('createTimes', () => {
  it('timed: anchors in the given zone, defaults to one hour', () => {
    expect(valueOf(createTimes({ start: '2026-10-01T14:00' }, 'Europe/Vienna'))).toEqual({
      endUtc: at('2026-10-01T13:00:00Z'),
      isAllDay: false,
      startTimeZone: 'Europe/Vienna',
      startUtc: at('2026-10-01T12:00:00Z'),
    });
    expect(
      valueOf(
        createTimes(
          { end: '2026-10-01T16:30', start: '2026-10-01T14:00', timeZone: 'America/New_York' },
          'UTC',
        ),
      ),
    ).toMatchObject({ startTimeZone: 'America/New_York', startUtc: at('2026-10-01T18:00:00Z') });
  });

  it('all-day: the inclusive last day becomes the stored exclusive end', () => {
    expect(valueOf(createTimes({ startDate: '2026-10-01' }, 'UTC'))).toEqual({
      endDate: '2026-10-02',
      endUtc: plainDateToUtcMs('2026-10-02'),
      isAllDay: true,
      startDate: '2026-10-01',
      startUtc: plainDateToUtcMs('2026-10-01'),
    });
    expect(
      valueOf(createTimes({ endDate: '2026-10-03', startDate: '2026-10-01' }, 'UTC')),
    ).toMatchObject({ endDate: '2026-10-04', startDate: '2026-10-01' });
  });

  it('refuses mixed, missing, reversed or unparseable input', () => {
    expect(
      messageOf(createTimes({ start: '2026-10-01T14:00', startDate: '2026-10-01' }, 'UTC')),
    ).toMatch(/not both/u);
    expect(messageOf(createTimes({}, 'UTC'))).toMatch(/needs start/u);
    expect(
      messageOf(createTimes({ end: '2026-10-01T13:00', start: '2026-10-01T14:00' }, 'UTC')),
    ).toMatch(/after start/u);
    expect(
      messageOf(createTimes({ endDate: '2026-09-30', startDate: '2026-10-01' }, 'UTC')),
    ).toMatch(/before startDate/u);
    expect(messageOf(createTimes({ start: 'soon' }, 'UTC'))).toMatch(/ISO 8601/u);
    expect(
      messageOf(createTimes({ start: '2026-10-01T14:00', timeZone: 'Mars/Olympus' }, 'UTC')),
    ).toMatch(/Unknown time zone/u);
  });
});

describe('updateTimes', () => {
  const timed: ExistingTimes = {
    endUtc: at('2026-10-01T13:30:00Z'),
    isAllDay: false,
    startTimeZone: 'Europe/Vienna',
    startUtc: at('2026-10-01T12:00:00Z'),
  };
  const allDay: ExistingTimes = {
    endDate: '2026-10-04',
    endUtc: plainDateToUtcMs('2026-10-04'),
    isAllDay: true,
    startDate: '2026-10-01',
    startUtc: plainDateToUtcMs('2026-10-01'),
  };

  it('leaves times alone when none are sent', () => {
    expect(valueOf(updateTimes({}, timed, 'UTC'))).toBeUndefined();
  });

  it('a moved start keeps the duration and reads in the event zone', () => {
    expect(valueOf(updateTimes({ start: '2026-10-02T09:00' }, timed, 'UTC'))).toEqual({
      endUtc: at('2026-10-02T07:00:00Z') + 1.5 * HOUR,
      isAllDay: false,
      startTimeZone: 'Europe/Vienna',
      startUtc: at('2026-10-02T07:00:00Z'),
    });
  });

  it('a lone end keeps the start', () => {
    expect(valueOf(updateTimes({ end: '2026-10-01T17:00:00+02:00' }, timed, 'UTC'))).toMatchObject({
      endUtc: at('2026-10-01T15:00:00Z'),
      startUtc: timed.startUtc,
    });
    expect(messageOf(updateTimes({ end: '2026-10-01T10:00:00+02:00' }, timed, 'UTC'))).toMatch(
      /after start/u,
    );
  });

  it('a moved all-day start keeps the span', () => {
    expect(valueOf(updateTimes({ startDate: '2026-10-10' }, allDay, 'UTC'))).toMatchObject({
      endDate: '2026-10-13',
      isAllDay: true,
      startDate: '2026-10-10',
    });
    expect(valueOf(updateTimes({ endDate: '2026-10-01' }, allDay, 'UTC'))).toMatchObject({
      endDate: '2026-10-02',
      startDate: '2026-10-01',
    });
  });

  it('switching kind needs the new start', () => {
    expect(valueOf(updateTimes({ startDate: '2026-10-05' }, timed, 'UTC'))).toMatchObject({
      endDate: '2026-10-06',
      isAllDay: true,
    });
    expect(messageOf(updateTimes({ endDate: '2026-10-05' }, timed, 'UTC'))).toMatch(
      /needs startDate/u,
    );
    expect(valueOf(updateTimes({ start: '2026-10-01T09:00Z' }, allDay, 'UTC'))).toMatchObject({
      endUtc: at('2026-10-01T10:00:00Z'),
      isAllDay: false,
    });
    expect(messageOf(updateTimes({ end: '2026-10-01T09:00Z' }, allDay, 'UTC'))).toMatch(
      /needs start/u,
    );
  });
});
