/**
 * All-day lane packing: multi-day chips span day columns; each chip takes the
 * first row where its day span is free (greedy interval packing).
 */

export interface AllDaySpan {
  /** Exclusive. */
  readonly endDayIndex: number;
  readonly id: string;
  readonly startDayIndex: number;
}

export interface PlacedSpan extends AllDaySpan {
  readonly row: number;
}

export const layoutAllDayLane = (
  spans: ReadonlyArray<AllDaySpan>,
  dayCount: number,
): { placed: Array<PlacedSpan>; rowCount: number } => {
  const sorted = [...spans]
    .map((span) => ({
      ...span,
      endDayIndex: Math.min(span.endDayIndex, dayCount),
      startDayIndex: Math.max(span.startDayIndex, 0),
    }))
    .filter((span) => span.endDayIndex > span.startDayIndex)
    .sort((a, b) => a.startDayIndex - b.startDayIndex || b.endDayIndex - a.endDayIndex);

  const rows: Array<Array<PlacedSpan>> = [];
  const placed: Array<PlacedSpan> = [];

  for (const span of sorted) {
    let row = 0;
    while (
      rows[row]?.some(
        (existing) =>
          existing.startDayIndex < span.endDayIndex && existing.endDayIndex > span.startDayIndex,
      )
    ) {
      row += 1;
    }
    const entry: PlacedSpan = { ...span, row };
    (rows[row] ??= []).push(entry);
    placed.push(entry);
  }

  return { placed, rowCount: rows.length };
};
