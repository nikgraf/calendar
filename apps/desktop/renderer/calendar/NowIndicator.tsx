import { useNow } from '@calendar/app-state';
import { Temporal, wallClockMinutes } from '@calendar/core';

/**
 * The red "now" line in today's column. It owns the minute tick, so the
 * clock re-renders this one element instead of the whole grid. It never
 * takes pointer input: a press on the line belongs to the event (or the
 * empty grid) under it — otherwise pressing an event where the line
 * crosses it would draw a new slot instead of moving the event.
 */
export function NowIndicator({ date, timeZone }: { date: Temporal.PlainDate; timeZone: string }) {
  const nowMs = useNow();
  // The column can outlive midnight until its parent re-renders.
  if (
    !Temporal.Instant.fromEpochMilliseconds(nowMs)
      .toZonedDateTimeISO(timeZone)
      .toPlainDate()
      .equals(date)
  ) {
    return null;
  }
  const fraction = wallClockMinutes(nowMs, timeZone) / (24 * 60);
  return (
    <div
      className="pointer-events-none absolute right-0 left-0 z-10 border-t-2 border-red-500"
      style={{ top: `${fraction * 100}%` }}
    >
      <span className="absolute -top-[5px] -left-1 size-2 rounded-full bg-red-500" />
    </div>
  );
}
