import type { EventRecord } from '../types.ts';

/** Whether the user turned the event down (it then blocks no time). */
export const isDeclinedBySelf = (
  event: Pick<EventRecord, 'attendees'>,
  accountEmail: string | undefined,
): boolean => {
  const own = accountEmail?.toLowerCase();
  return (event.attendees ?? []).some(
    (attendee) =>
      attendee.responseStatus === 'declined' &&
      (attendee.isSelf === true || (own !== undefined && attendee.email.toLowerCase() === own)),
  );
};

/**
 * Busy intervals clipped to a range and merged, so neither which calendar
 * a block came from nor how many events overlap in it can be read back.
 * Shared by the agent gateway's free/busy answer and the availability
 * mirror.
 */
export const mergeBusy = (
  events: ReadonlyArray<{ readonly endUtc: number; readonly startUtc: number }>,
  range: { readonly endUtc: number; readonly startUtc: number },
): Array<{ endUtc: number; startUtc: number }> => {
  const clipped = events
    .map((event) => ({
      endUtc: Math.min(event.endUtc, range.endUtc),
      startUtc: Math.max(event.startUtc, range.startUtc),
    }))
    .filter((interval) => interval.endUtc > interval.startUtc)
    .sort((a, b) => a.startUtc - b.startUtc);
  const merged: Array<{ endUtc: number; startUtc: number }> = [];
  for (const interval of clipped) {
    const last = merged.at(-1);
    if (last && interval.startUtc <= last.endUtc) {
      last.endUtc = Math.max(last.endUtc, interval.endUtc);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
};
