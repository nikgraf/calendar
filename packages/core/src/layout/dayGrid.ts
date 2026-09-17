/**
 * Day-column layout: the classic calendar packing algorithm. Overlapping
 * events form clusters; within a cluster each event takes the leftmost free
 * column, and every member's width is 1/columnCount of the cluster.
 * All coordinates are fractions (0..1) of the day window / column width.
 */

export interface TimedBox {
  readonly endUtc: number;
  readonly id: string;
  /** Optional fixed-day coordinates for wall-clock items such as reminders. */
  readonly layoutEndMinute?: number;
  readonly layoutStartMinute?: number;
  readonly startUtc: number;
}

export interface PositionedBox {
  readonly height: number;
  readonly id: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

export const layoutDayColumn = (
  events: ReadonlyArray<TimedBox>,
  dayStartUtc: number,
  dayEndUtc: number,
): Array<PositionedBox> => {
  const dayMs = dayEndUtc - dayStartUtc;
  if (dayMs <= 0) {
    return [];
  }

  const sorted = [...events]
    .filter((event) => event.endUtc > dayStartUtc && event.startUtc < dayEndUtc)
    .map((event) => {
      const usesWallClockLayout =
        event.layoutStartMinute !== undefined && event.layoutEndMinute !== undefined;
      // Pack the same visual intervals we render, including on 23/25-hour days.
      return {
        end: usesWallClockLayout
          ? Math.min(event.layoutEndMinute, 24 * 60) / (24 * 60)
          : (Math.min(event.endUtc, dayEndUtc) - dayStartUtc) / dayMs,
        id: event.id,
        start: usesWallClockLayout
          ? Math.max(event.layoutStartMinute, 0) / (24 * 60)
          : (Math.max(event.startUtc, dayStartUtc) - dayStartUtc) / dayMs,
      };
    })
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
