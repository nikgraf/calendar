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

export interface CappedAllDayLane {
  /** Hidden chips per day column; a count above zero draws a "+N more" chip at row maxRows - 1. */
  readonly moreByDay: ReadonlyArray<number>;
  /** Rows the capped lane draws: the packed count, at most maxRows. */
  readonly rowCount: number;
  readonly visible: ReadonlyArray<PlacedSpan>;
}

/**
 * Caps a packed lane at `maxRows`. A column overflows when more than
 * `maxRows` chips cover it (or a chip packed below the cap does): there the
 * last row gives way to a "+N more" chip, so every chip at row `maxRows - 1`
 * covering an overflowing column hides too — a multi-day chip counts in
 * each column it covers. A lane that fits loses nothing, so collapsing an
 * ordinary week changes no geometry.
 */
export const capAllDayLane = (
  placed: ReadonlyArray<PlacedSpan>,
  dayCount: number,
  maxRows: number,
): CappedAllDayLane => {
  const covering = Array.from({ length: dayCount }, () => 0);
  const overflowing = Array.from({ length: dayCount }, () => false);
  let packedRows = 0;
  for (const span of placed) {
    packedRows = Math.max(packedRows, span.row + 1);
    for (let day = span.startDayIndex; day < span.endDayIndex; day += 1) {
      covering[day] = (covering[day] ?? 0) + 1;
      if (span.row >= maxRows) {
        overflowing[day] = true;
      }
    }
  }
  for (let day = 0; day < dayCount; day += 1) {
    if ((covering[day] ?? 0) > maxRows) {
      overflowing[day] = true;
    }
  }
  const moreByDay = Array.from({ length: dayCount }, () => 0);
  const visible: Array<PlacedSpan> = [];
  for (const span of placed) {
    const coversOverflow = overflowing.slice(span.startDayIndex, span.endDayIndex).some(Boolean);
    const hidden = span.row >= maxRows || (span.row === maxRows - 1 && coversOverflow);
    if (!hidden) {
      visible.push(span);
      continue;
    }
    for (let day = span.startDayIndex; day < span.endDayIndex; day += 1) {
      moreByDay[day] = (moreByDay[day] ?? 0) + 1;
    }
  }
  return { moreByDay, rowCount: Math.min(packedRows, maxRows), visible };
};
