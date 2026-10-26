import { describe, expect, it } from 'vite-plus/test';
import { applyWallClockDelta, moveEventTimes, resizeEventEnd, snapMinutes } from './dragMath.ts';

const HOUR = 60 * 60 * 1000;
const event = {
  endUtc: Date.parse('2026-07-03T11:00:00Z'),
  startUtc: Date.parse('2026-07-03T10:00:00Z'),
};

describe('dragMath', () => {
  it('snaps to 15-minute steps, rounding to nearest', () => {
    expect(snapMinutes(0)).toBe(0);
    expect(snapMinutes(7)).toBe(0);
    expect(snapMinutes(8)).toBe(15);
    expect(snapMinutes(22)).toBe(15);
    expect(snapMinutes(23)).toBe(30);
    expect(snapMinutes(-8)).toBe(-15);
    expect(snapMinutes(-7)).toBe(-0);
  });

  it('moves preserving duration, snapped', () => {
    const moved = moveEventTimes(event, 'UTC', 37); // snaps to 30
    expect(moved.startUtc).toBe(Date.parse('2026-07-03T10:30:00Z'));
    expect(moved.endUtc - moved.startUtc).toBe(HOUR);
  });

  it('moves across days and backwards', () => {
    const moved = moveEventTimes(event, 'UTC', -30, 2);
    expect(moved.startUtc).toBe(Date.parse('2026-07-05T09:30:00Z'));
    expect(moved.endUtc - moved.startUtc).toBe(HOUR);
  });

  it('resizes the end with snapping', () => {
    expect(resizeEventEnd(event, 'UTC', 44).endUtc).toBe(Date.parse('2026-07-03T11:45:00Z'));
  });

  it('clamps resize to the minimum duration', () => {
    expect(resizeEventEnd(event, 'UTC', -3 * 60).endUtc).toBe(event.startUtc + 15 * 60 * 1000);
  });
});

describe('DST-aware shifts', () => {
  // Europe/Vienna springs forward on 2026-03-29 (+01:00 -> +02:00).
  it('keeps the wall-clock time when dragging across the spring-forward day', () => {
    const moved = moveEventTimes(
      {
        // Sat Mar 28, 09:00 Vienna (+01:00)
        endUtc: Date.parse('2026-03-28T09:00:00Z'),
        startUtc: Date.parse('2026-03-28T08:00:00Z'),
      },
      'Europe/Vienna',
      0,
      1,
    );
    // Sun Mar 29, 09:00 Vienna is +02:00 -> 07:00Z.
    expect(moved.startUtc).toBe(Date.parse('2026-03-29T07:00:00Z'));
    expect(moved.endUtc - moved.startUtc).toBe(60 * 60 * 1000);
  });

  // The grid's zone counts, not the event's: the block lands on the row it
  // was dropped on even when only one of the two zones changes that night.
  it('moves in the grid zone when the event is in another one', () => {
    // A Vienna event on a UTC grid: Sat Oct 24, 09:00 UTC (11:00 Vienna),
    // dropped one column right and two hours down, on Sunday's 11:00 row.
    const moved = moveEventTimes(
      { endUtc: Date.parse('2026-10-24T10:00:00Z'), startUtc: Date.parse('2026-10-24T09:00:00Z') },
      'UTC',
      120,
      1,
    );
    // In Vienna's wall clock it would be Sun 13:00 (+01:00), 12:00Z.
    expect(moved.startUtc).toBe(Date.parse('2026-10-25T11:00:00Z'));
    expect(moved.endUtc).toBe(Date.parse('2026-10-25T12:00:00Z'));
  });

  it('resizes to the row the end was dropped on across a change', () => {
    // Vienna falls back on 2026-10-25: an end at 01:30 (+02:00) dragged two
    // hours down lands on the 03:30 row (+01:00), three hours later.
    const resized = resizeEventEnd(
      {
        endUtc: Date.parse('2026-10-24T23:30:00Z'),
        startUtc: Date.parse('2026-10-24T22:30:00Z'),
      },
      'Europe/Vienna',
      120,
    );
    expect(resized.endUtc).toBe(Date.parse('2026-10-25T02:30:00Z'));
  });

  it('moves diagonally: days one way, minutes the other', () => {
    // Fri Jul 3, 12:00 Vienna (+02:00).
    const vienna = {
      endUtc: Date.parse('2026-07-03T11:00:00Z'),
      startUtc: Date.parse('2026-07-03T10:00:00Z'),
    };
    expect(moveEventTimes(vienna, 'Europe/Vienna', -30, 2).startUtc).toBe(
      Date.parse('2026-07-05T09:30:00Z'),
    );
    expect(moveEventTimes(vienna, 'Europe/Vienna', 60, -1).startUtc).toBe(
      Date.parse('2026-07-02T11:00:00Z'),
    );
    // A series follows an occurrence moved a day later and half an hour earlier.
    expect(
      applyWallClockDelta(
        vienna.startUtc,
        'Europe/Vienna',
        vienna.startUtc,
        Date.parse('2026-07-04T09:30:00Z'),
      ),
    ).toBe(Date.parse('2026-07-04T09:30:00Z'));
  });

  it('keeps the second pass through the repeated hour', () => {
    // 02:00–02:30 Vienna for the second time (+01:00). Picking the first
    // 02:45 (+02:00) would end it before it starts, clamped short.
    const event = {
      endUtc: Date.parse('2026-10-25T01:30:00Z'),
      startUtc: Date.parse('2026-10-25T01:00:00Z'),
    };
    expect(resizeEventEnd(event, 'Europe/Vienna', 15).endUtc).toBe(
      Date.parse('2026-10-25T01:45:00Z'),
    );
    expect(moveEventTimes(event, 'Europe/Vienna', 15)).toEqual({
      endUtc: Date.parse('2026-10-25T01:45:00Z'),
      startUtc: Date.parse('2026-10-25T01:15:00Z'),
    });
    // A delta that snaps to nothing leaves it where it is.
    expect(moveEventTimes(event, 'Europe/Vienna', 5)).toEqual(event);
    // The first 02:00 (+02:00) a day later takes +01:00, the only offset left.
    const first = {
      endUtc: Date.parse('2026-10-25T00:30:00Z'),
      startUtc: Date.parse('2026-10-25T00:00:00Z'),
    };
    expect(moveEventTimes(first, 'Europe/Vienna', 0, 1).startUtc).toBe(
      Date.parse('2026-10-26T01:00:00Z'),
    );
  });

  it('applies a wall-clock series delta across DST regimes', () => {
    // The occurrence moved Mar 28 09:00 -> Mar 30 09:00 Vienna (2 wall days,
    // but 46 absolute hours because of the transition in between).
    const shifted = applyWallClockDelta(
      // Series start: Jun 1, 09:00 Vienna (+02:00).
      Date.parse('2026-06-01T07:00:00Z'),
      'Europe/Vienna',
      Date.parse('2026-03-28T08:00:00Z'),
      Date.parse('2026-03-30T07:00:00Z'),
    );
    // Wall delta is exactly +2 days: Jun 3, 09:00 Vienna.
    expect(shifted).toBe(Date.parse('2026-06-03T07:00:00Z'));
  });

  it('shifts a series into the pass of the repeated hour its occurrence took', () => {
    // The first occurrence, Sun Oct 25 04:00 Vienna (+01:00), retimed to the
    // first 02:30 (+02:00): the series starts there, not at the second one.
    const start = Date.parse('2026-10-25T03:00:00Z');
    expect(
      applyWallClockDelta(start, 'Europe/Vienna', start, Date.parse('2026-10-25T00:30:00Z')),
    ).toBe(Date.parse('2026-10-25T00:30:00Z'));
  });

  it('carries a series shift to the second', () => {
    // A start at 09:00:30 Vienna retimed to 10:00 takes the series to 10:00.
    const start = Date.parse('2026-07-01T07:00:30Z');
    expect(
      applyWallClockDelta(start, 'Europe/Vienna', start, Date.parse('2026-07-01T08:00:00Z')),
    ).toBe(Date.parse('2026-07-01T08:00:00Z'));
    // A later occurrence moved a day later and earlier in the day, to the
    // millisecond.
    expect(
      applyWallClockDelta(
        start,
        'Europe/Vienna',
        Date.parse('2026-07-03T07:00:30.500Z'),
        Date.parse('2026-07-04T06:45:00Z'),
      ),
    ).toBe(Date.parse('2026-07-02T06:45:00Z') - 500);
    // An occurrence that kept its seconds keeps them on the series.
    expect(
      applyWallClockDelta(start, 'Europe/Vienna', start, Date.parse('2026-07-01T08:00:30Z')),
    ).toBe(Date.parse('2026-07-01T08:00:30Z'));
  });

  it('keeps the seconds of a dragged start', () => {
    const moved = moveEventTimes(
      {
        endUtc: Date.parse('2026-07-03T11:00:30Z'),
        startUtc: Date.parse('2026-07-03T10:00:30Z'),
      },
      'Europe/Vienna',
      -30,
      1,
    );
    expect(moved.startUtc).toBe(Date.parse('2026-07-04T09:30:30Z'));
  });

  it('applies pure time-of-day deltas', () => {
    const shifted = applyWallClockDelta(
      Date.parse('2026-01-05T08:00:00Z'), // Jan 5, 09:00 Vienna (+01:00)
      'Europe/Vienna',
      Date.parse('2026-07-06T07:00:00Z'), // Jul 6, 09:00 Vienna (+02:00)
      Date.parse('2026-07-06T08:30:00Z'), // -> 10:30
    );
    expect(shifted).toBe(Date.parse('2026-01-05T09:30:00Z')); // Jan 5, 10:30 Vienna
  });
});
