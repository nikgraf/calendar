import { Temporal } from '../time/temporal.ts';
import { toZonedDateTime } from '../time/convert.ts';
import { MIRROR_PAST_DAYS, type MirrorDefinition } from './definition.ts';

/**
 * The days a mirror manages: a week back, `monthsAhead` months ahead, in
 * whole days of the mirror's own zone — so every device computes the same
 * window and the same "today". A copy that starts outside it is left
 * exactly as it is: never rewritten, never deleted.
 */
export interface MirrorWindow {
  /** Exclusive 'YYYY-MM-DD'. */
  readonly endDate: string;
  /** Exclusive: midnight of `endDate` in the mirror's zone. */
  readonly endUtc: number;
  readonly startDate: string;
  readonly startUtc: number;
  readonly today: string;
}

const midnight = (date: Temporal.PlainDate, timeZone: string): number =>
  date.toZonedDateTime(timeZone).epochMilliseconds;

export const mirrorWindow = (
  definition: Pick<MirrorDefinition, 'monthsAhead' | 'timeZone'>,
  nowMs: number,
): MirrorWindow => {
  const today = toZonedDateTime(nowMs, definition.timeZone).toPlainDate();
  const start = today.subtract({ days: MIRROR_PAST_DAYS });
  const end = today.add({ months: definition.monthsAhead });
  return {
    endDate: end.toString(),
    endUtc: midnight(end, definition.timeZone),
    startDate: start.toString(),
    startUtc: midnight(start, definition.timeZone),
    today: today.toString(),
  };
};

/** Whether something starting then belongs to the window (by its start alone). */
export const startsInMirrorWindow = (
  window: MirrorWindow,
  item: {
    readonly allDay: boolean;
    readonly startDate?: string | undefined;
    readonly startUtc: number;
  },
): boolean =>
  item.allDay && item.startDate !== undefined
    ? item.startDate >= window.startDate && item.startDate < window.endDate
    : item.startUtc >= window.startUtc && item.startUtc < window.endUtc;
