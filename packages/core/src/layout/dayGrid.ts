/**
 * Day-column layout: the classic calendar packing algorithm. Overlapping
 * events form clusters; within a cluster each event takes the leftmost free
 * column, and every member's width is 1/columnCount of the cluster.
 * All coordinates are fractions (0..1) of the day window / column width.
 */

export interface TimedBox {
  readonly endUtc: number;
  readonly id: string;
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
    .sort((a, b) => a.startUtc - b.startUtc || b.endUtc - a.endUtc);

  interface Placed extends TimedBox {
    column: number;
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
      const start = Math.max(entry.startUtc, dayStartUtc);
      const end = Math.min(entry.endUtc, dayEndUtc);
      results.push({
        height: (end - start) / dayMs,
        id: entry.id,
        left: entry.column / columnCount,
        top: (start - dayStartUtc) / dayMs,
        width: 1 / columnCount,
      });
    }
    cluster = [];
    clusterEnd = Number.NEGATIVE_INFINITY;
  };

  for (const event of sorted) {
    if (event.startUtc >= clusterEnd) {
      flushCluster();
    }
    // Leftmost column whose events this one does not overlap.
    const occupied = new Set(
      cluster.filter((entry) => entry.endUtc > event.startUtc).map((entry) => entry.column),
    );
    let column = 0;
    while (occupied.has(column)) {
      column += 1;
    }
    cluster.push({ ...event, column });
    clusterEnd = Math.max(clusterEnd, event.endUtc);
  }
  flushCluster();

  return results;
};
