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

/** Shown as "Free" (Google's `transparent`): on the calendar, but it blocks no time. */
export const isMarkedFree = (event: Pick<EventRecord, 'transparency'>): boolean =>
  event.transparency === 'transparent';

/**
 * The one availability rule: what blocks time is timed, not cancelled,
 * not marked free and not declined. All-day entries mark days rather
 * than hours. Find-a-time and the agent gateway's free/busy and slot
 * answers read it; a mirror flags its items with the same two
 * predicates, and its availability preset skips both.
 */
export const blocksTime = (
  event: Pick<EventRecord, 'attendees' | 'isAllDay' | 'status' | 'transparency'>,
  accountEmail: string | undefined,
): boolean =>
  !event.isAllDay &&
  event.status !== 'cancelled' &&
  !isMarkedFree(event) &&
  !isDeclinedBySelf(event, accountEmail);

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
