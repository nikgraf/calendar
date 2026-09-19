import { Temporal } from '../time/temporal.ts';

/**
 * Day-column layout: the classic calendar packing algorithm. Overlapping
 * events form clusters; within a cluster each event takes the leftmost free
 * column, and every member's width is 1/columnCount of the cluster.
 * All coordinates are fractions (0..1) of the day column / column width.
 *
 * The column is a fixed 24-hour wall clock — the hour lines, slot clicks and
 * drags all assume it — so boxes are placed by wall-clock minute, never by
 * elapsed time. On a 23- or 25-hour DST day an event still sits beside its
 * hour label, like Google Calendar's grid.
 */

const DAY_MINUTES = 24 * 60;

export interface TimedBox {
  /** Wall-clock minutes from the column's midnight; clipped to 0..1440. */
  readonly endMinute: number;
  readonly id: string;
  readonly startMinute: number;
}

export interface PositionedBox {
  readonly height: number;
  readonly id: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

/** Wall-clock minutes of `epochMs` on `date`'s grid, clamped to that day. */
const minuteOnDay = (epochMs: number, date: Temporal.PlainDate, timeZone: string): number => {
  const zoned = Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timeZone);
  const order = Temporal.PlainDate.compare(zoned.toPlainDate(), date);
  if (order !== 0) {
    return order < 0 ? 0 : DAY_MINUTES;
  }
  return zoned.hour * 60 + zoned.minute + zoned.second / 60;
};

/** Minutes since local midnight at `epochMs` — where the "now" line sits. */
export const wallClockMinutes = (epochMs: number, timeZone: string): number => {
  const zoned = Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timeZone);
  return zoned.hour * 60 + zoned.minute + zoned.second / 60;
};

/** A timed event's box on `date`'s column, clipped to that day. */
export const timedEventBox = (
  event: { readonly endUtc: number; readonly startUtc: number },
  id: string,
  date: Temporal.PlainDate,
  timeZone: string,
): TimedBox => {
  const startMinute = minuteOnDay(event.startUtc, date, timeZone);
  // Inside a fall-back's repeated hour a short event can end at an earlier
  // wall-clock minute than it starts; draw it at its start, minimum height.
  const endMinute = Math.max(minuteOnDay(event.endUtc, date, timeZone), startMinute);
  return { endMinute, id, startMinute };
};

export const layoutDayColumn = (boxes: ReadonlyArray<TimedBox>): Array<PositionedBox> => {
  const sorted = boxes
    .map((box) => ({
      end: Math.min(box.endMinute, DAY_MINUTES) / DAY_MINUTES,
      id: box.id,
      start: Math.max(box.startMinute, 0) / DAY_MINUTES,
    }))
    .filter((box) => box.end > 0 && box.start < 1)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  interface Placed {
    column: number;
    end: number;
    id: string;
    start: number;
  }

  const results: Array<PositionedBox> = [];
  let cluster: Array<Placed> = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;

  const flushCluster = () => {
    if (cluster.length === 0) {
      return;
    }
    const columnCount = Math.max(...cluster.map((entry) => entry.column)) + 1;
    for (const entry of cluster) {
      results.push({
        height: entry.end - entry.start,
        id: entry.id,
        left: entry.column / columnCount,
        top: entry.start,
        width: 1 / columnCount,
      });
    }
    cluster = [];
    clusterEnd = Number.NEGATIVE_INFINITY;
  };

  for (const event of sorted) {
    if (event.start >= clusterEnd) {
      flushCluster();
    }
    // Leftmost column whose events this one does not overlap.
    const occupied = new Set(
      cluster.filter((entry) => entry.end > event.start).map((entry) => entry.column),
    );
    let column = 0;
    while (occupied.has(column)) {
      column += 1;
    }
    cluster.push({ ...event, column });
    clusterEnd = Math.max(clusterEnd, event.end);
  }
  flushCluster();

  return results;
};
