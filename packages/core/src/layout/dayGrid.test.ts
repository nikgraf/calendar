import { describe, expect, it } from 'vitest';
import { timedTaskSlot } from '../taskTiming.ts';
import { Temporal } from '../time/temporal.ts';
import { layoutAllDayLane } from './allDayLane.ts';
import { layoutDayColumn, timedEventBox, wallClockMinutes } from './dayGrid.ts';

const box = (id: string, startHour: number, endHour: number) => ({
  endMinute: endHour * 60,
  id,
  startMinute: startHour * 60,
});

describe('layoutDayColumn', () => {
  it('gives a lone event the full width', () => {
    const [placed] = layoutDayColumn([box('a', 9, 10)]);
    expect(placed).toEqual({
      height: expect.closeTo(1 / 24),
      id: 'a',
      left: 0,
      top: 9 / 24,
      width: 1,
    });
  });

  it('splits two overlapping events into half-width columns', () => {
    const placed = layoutDayColumn([box('a', 9, 11), box('b', 10, 12)]);
    expect(placed.find((entry) => entry.id === 'a')).toMatchObject({
      left: 0,
      width: 0.5,
    });
    expect(placed.find((entry) => entry.id === 'b')).toMatchObject({
      left: 0.5,
      width: 0.5,
    });
  });

  it('reuses freed columns within a cluster', () => {
    // Equal starts sort longest-first: b(9–12) takes column 0, a(9–10)
    // column 1; when a ends, c(10–11) reuses a's freed column.
    const placed = layoutDayColumn([box('a', 9, 10), box('b', 9, 12), box('c', 10, 11)]);
    const byId = Object.fromEntries(placed.map((entry) => [entry.id, entry]));
    expect(byId['b']).toMatchObject({ left: 0, width: 0.5 });
    expect(byId['a']).toMatchObject({ left: 0.5, width: 0.5 });
    expect(byId['c']).toMatchObject({ left: 0.5, width: 0.5 });
  });

  it('keeps separate clusters full width', () => {
    const placed = layoutDayColumn([box('a', 9, 10), box('b', 14, 15)]);
    expect(placed.every((entry) => entry.width === 1)).toBe(true);
  });

  it('clips boxes to the day and drops ones outside it', () => {
    const placed = layoutDayColumn([box('a', -2, 2), box('before', -2, 0), box('after', 24, 25)]);
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ height: 2 / 24, id: 'a', top: 0 });
  });

  it.each(['2026-03-29', '2026-10-25'])(
    'separates an event from reminders during it on %s',
    (dueDate) => {
      const timeZone = 'Europe/Vienna';
      const epoch = (time: string) =>
        Temporal.PlainDateTime.from(`${dueDate}T${time}`).toZonedDateTime(timeZone)
          .epochMilliseconds;
      const placed = layoutDayColumn([
        ...['09:15', '09:30', '09:45'].map((dueTime) => ({
          ...timedTaskSlot({ dueDate, dueTime })!,
          id: dueTime,
        })),
        timedEventBox(
          { endUtc: epoch('10:00'), startUtc: epoch('09:00') },
          'event',
          Temporal.PlainDate.from(dueDate),
          timeZone,
        ),
      ]);

      // The event sits beside its hour label even on a 23/25-hour day.
      const positionedEvent = placed.find((entry) => entry.id === 'event')!;
      expect(positionedEvent.top).toBeCloseTo(9 / 24);
      expect(positionedEvent.height).toBeCloseTo(1 / 24);
      expect(placed).toHaveLength(4);
      expect(placed.every((entry) => entry.width < 1)).toBe(true);

      for (const [index, entry] of placed.entries()) {
        for (const other of placed.slice(index + 1)) {
          if (entry.top < other.top + other.height && other.top < entry.top + entry.height) {
            expect(
              entry.left + entry.width <= other.left || other.left + other.width <= entry.left,
            ).toBe(true);
          }
        }
      }
    },
  );
});

describe('timedEventBox', () => {
  const timeZone = 'Europe/Vienna';
  const day = Temporal.PlainDate.from('2026-03-28');
  const epoch = (iso: string) =>
    Temporal.PlainDateTime.from(iso).toZonedDateTime(timeZone).epochMilliseconds;

  it('places an event by its wall-clock minutes', () => {
    expect(
      timedEventBox(
        { endUtc: epoch('2026-03-28T10:30'), startUtc: epoch('2026-03-28T09:15') },
        'a',
        day,
        timeZone,
      ),
    ).toEqual({ endMinute: 10 * 60 + 30, id: 'a', startMinute: 9 * 60 + 15 });
  });

  it('clips a multi-day event to the column', () => {
    expect(
      timedEventBox(
        { endUtc: epoch('2026-03-29T02:00'), startUtc: epoch('2026-03-27T22:00') },
        'a',
        day,
        timeZone,
      ),
    ).toEqual({ endMinute: 24 * 60, id: 'a', startMinute: 0 });
  });

  it('draws the hours across spring-forward at their labels', () => {
    // 01:30–03:30 is one elapsed hour, but spans two rows of the 24-hour grid.
    const springDay = Temporal.PlainDate.from('2026-03-29');
    expect(
      timedEventBox(
        { endUtc: epoch('2026-03-29T03:30'), startUtc: epoch('2026-03-29T01:30') },
        'a',
        springDay,
        timeZone,
      ),
    ).toEqual({ endMinute: 3 * 60 + 30, id: 'a', startMinute: 60 + 30 });
  });

  it('never ends before it starts inside the fall-back repeated hour', () => {
    // 02:45 (summer time) to 02:15 (winter time) is 30 elapsed minutes.
    const fallDay = Temporal.PlainDate.from('2026-10-25');
    const startUtc = Temporal.ZonedDateTime.from(
      '2026-10-25T02:45:00+02:00[Europe/Vienna]',
    ).epochMilliseconds;
    const box = timedEventBox(
      { endUtc: startUtc + 30 * 60 * 1000, startUtc },
      'a',
      fallDay,
      timeZone,
    );
    expect(box).toEqual({ endMinute: 2 * 60 + 45, id: 'a', startMinute: 2 * 60 + 45 });
  });
});

describe('wallClockMinutes', () => {
  it('reads the local minute on a 23-hour day', () => {
    const nine = Temporal.ZonedDateTime.from('2026-03-29T09:15:00+02:00[Europe/Vienna]');
    expect(wallClockMinutes(nine.epochMilliseconds, 'Europe/Vienna')).toBe(9 * 60 + 15);
  });
});

describe('layoutAllDayLane', () => {
  it('packs non-overlapping spans into one row', () => {
    const { placed, rowCount } = layoutAllDayLane(
      [
        { endDayIndex: 2, id: 'a', startDayIndex: 0 },
        { endDayIndex: 5, id: 'b', startDayIndex: 2 },
      ],
      7,
    );
    expect(rowCount).toBe(1);
    expect(placed.every((entry) => entry.row === 0)).toBe(true);
  });

  it('stacks overlapping spans and clips to the window', () => {
    const { placed, rowCount } = layoutAllDayLane(
      [
        { endDayIndex: 9, id: 'long', startDayIndex: -3 },
        { endDayIndex: 3, id: 'mid', startDayIndex: 1 },
        { endDayIndex: 4, id: 'third', startDayIndex: 2 },
      ],
      7,
    );
    expect(rowCount).toBe(3);
    const long = placed.find((entry) => entry.id === 'long');
    expect(long).toMatchObject({ endDayIndex: 7, row: 0, startDayIndex: 0 });
  });
});
