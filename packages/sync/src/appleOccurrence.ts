import {
  APPLE_WRITE_REACH_MS,
  type AppleCalendarClientShape,
  type AppleCalendarError,
  type AppleEventJson,
} from '@calendar/apple-calendar';
import { Effect } from 'effect';

/**
 * Whether `event` is the occurrence of series `id` its rule drew at
 * `originalStartUtc`. The slot survives the occurrence being moved or
 * edited on its own, so it names the occurrence wherever it sits now.
 */
export const isAppleOccurrence = (
  event: AppleEventJson,
  ref: { readonly id: string; readonly originalStartUtc: number },
): boolean =>
  event.id === ref.id &&
  event.occurrenceStartUtc === ref.originalStartUtc &&
  event.status !== 'cancelled';

/**
 * One occurrence of an Apple series as EventKit has it now, where a write
 * by its slot can reach it; undefined when it is gone or sits further off.
 */
export const findAppleOccurrence = (
  client: Pick<AppleCalendarClientShape, 'events'>,
  ref: { readonly id: string; readonly originalStartUtc: number },
): Effect.Effect<AppleEventJson | undefined, AppleCalendarError> =>
  Effect.map(
    client.events({
      endUtc: ref.originalStartUtc + APPLE_WRITE_REACH_MS,
      startUtc: ref.originalStartUtc - APPLE_WRITE_REACH_MS,
    }),
    (nearby) => nearby.find((event) => isAppleOccurrence(event, ref)),
  );
