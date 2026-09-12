import { useNow } from '@calendar/app-state';

/**
 * The red "now" line in today's column. It owns the minute tick, so the
 * clock re-renders this one element instead of the whole grid.
 */
export function NowIndicator({
  rangeEndUtc,
  rangeStartUtc,
}: {
  rangeEndUtc: number;
  rangeStartUtc: number;
}) {
  const nowMs = useNow();
  const fraction = (nowMs - rangeStartUtc) / (rangeEndUtc - rangeStartUtc);
  if (fraction < 0 || fraction > 1) {
    return null;
  }
  return (
    <div
      className="absolute right-0 left-0 z-10 border-t-2 border-red-500"
      style={{ top: `${fraction * 100}%` }}
    >
      <span className="absolute -top-[5px] -left-1 size-2 rounded-full bg-red-500" />
    </div>
  );
}
