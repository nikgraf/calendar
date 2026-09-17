import { describe, expect, it } from 'vitest';
import { timedTaskSlot } from '../taskTiming.ts';
import { dayRange } from '../time/ranges.ts';
import { Temporal } from '../time/temporal.ts';
import { layoutAllDayLane } from './allDayLane.ts';
import { layoutDayColumn } from './dayGrid.ts';

const HOUR = 60 * 60 * 1000;
const DAY_START = 0;
const DAY_END = 24 * HOUR;

const box = (id: string, startHour: number, endHour: number) => ({
  endUtc: endHour * HOUR,
  id,
  startUtc: startHour * HOUR,
});

describe('layoutDayColumn', () => {
  it('gives a lone event the full width', () => {
    const [placed] = layoutDayColumn([box('a', 9, 10)], DAY_START, DAY_END);
    expect(placed).toEqual({
      height: expect.closeTo(1 / 24),
      id: 'a',
      left: 0,
      top: 9 / 24,
      width: 1,
    });
  });

  it('splits two overlapping events into half-width columns', () => {
    const placed = layoutDayColumn([box('a', 9, 11), box('b', 10, 12)], DAY_START, DAY_END);
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
    const placed = layoutDayColumn(
      [box('a', 9, 10), box('b', 9, 12), box('c', 10, 11)],
      DAY_START,
      DAY_END,
    );
    const byId = Object.fromEntries(placed.map((entry) => [entry.id, entry]));
    expect(byId['b']).toMatchObject({ left: 0, width: 0.5 });
    expect(byId['a']).toMatchObject({ left: 0.5, width: 0.5 });
    expect(byId['c']).toMatchObject({ left: 0.5, width: 0.5 });
  });

  it('keeps separate clusters full width', () => {
    const placed = layoutDayColumn([box('a', 9, 10), box('b', 14, 15)], DAY_START, DAY_END);
    expect(placed.every((entry) => entry.width === 1)).toBe(true);
  });

  it('clips events crossing the day boundary', () => {
    const placed = layoutDayColumn([box('a', -2, 2)], DAY_START, DAY_END);
    expect(placed[0]).toMatchObject({ height: 2 / 24, top: 0 });
  });

  it('uses optional wall-clock minutes for visual coordinates', () => {
    const springForwardDayEnd = 23 * HOUR;
    const [placed] = layoutDayColumn(
      [
        {
          ...box('reminder', 8, 8.5),
          layoutEndMinute: 9.5 * 60,
          layoutStartMinute: 9 * 60,
        },
      ],
      DAY_START,
      springForwardDayEnd,
    );

    expect(placed).toMatchObject({ height: expect.closeTo(0.5 / 24), top: 9 / 24 });
  });

  it.each([
    {
      dueDate: '2026-03-29',
      eventEnd: '11:00',
      eventStart: '10:00',
      reminderTimes: ['09:30', '09:45', '10:00'],
    },
    {
      dueDate: '2026-10-25',
      eventEnd: '10:00',
      eventStart: '09:00',
      reminderTimes: ['10:00', '10:15', '10:30'],
    },
  ])(
    'separates visually overlapping events and reminders on $dueDate',
    ({ dueDate, eventEnd, eventStart, reminderTimes }) => {
      const timeZone = 'Europe/Vienna';
      const range = dayRange(Temporal.PlainDate.from(dueDate), timeZone);
      const epoch = (time: string) =>
        Temporal.PlainDateTime.from(`${dueDate}T${time}`).toZonedDateTime(timeZone)
          .epochMilliseconds;
      const event = { endUtc: epoch(eventEnd), id: 'event', startUtc: epoch(eventStart) };
      const placed = layoutDayColumn(
        [
          ...reminderTimes.map((dueTime) => ({
            ...timedTaskSlot({ dueDate, dueTime }, timeZone)!,
            id: dueTime,
          })),
          event,
        ],
        range.startUtc,
        range.endUtc,
      );

      // Event positions retain their existing elapsed-day coordinates.
      const positionedEvent = placed.find((entry) => entry.id === 'event')!;
      const dayMs = range.endUtc - range.startUtc;
      expect(positionedEvent.top).toBeCloseTo((event.startUtc - range.startUtc) / dayMs);
      expect(positionedEvent.height).toBeCloseTo((event.endUtc - event.startUtc) / dayMs);
      expect(placed).toHaveLength(4);
      expect(placed[0]?.id).toBe('event');
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

  it('filters wall-clock items by their UTC day before positioning them', () => {
    const placed = layoutDayColumn(
      [-24, 0, 24].map((offset) => ({
        ...box(String(offset), offset + 9, offset + 9.5),
        layoutEndMinute: 9.5 * 60,
        layoutStartMinute: 9 * 60,
      })),
      DAY_START,
      DAY_END,
    );

    expect(placed).toHaveLength(1);
    expect(placed[0]?.id).toBe('0');
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
