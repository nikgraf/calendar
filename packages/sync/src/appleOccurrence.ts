import type {
  AppleCalendarClientShape,
  AppleCalendarError,
  AppleEventJson,
} from '@calendar/apple-calendar';
import { Effect } from 'effect';

/**
 * How far from its slot an occurrence moved on its own is still looked
 * for. EventKit only answers ranges, and the bridge's own lookup reaches
 * 31 days: this stays wider, so whatever a write can address is found.
 */
export const APPLE_OCCURRENCE_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;

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

/** One occurrence of an Apple series as EventKit has it now, or undefined when it is gone. */
export const findAppleOccurrence = (
  client: Pick<AppleCalendarClientShape, 'events'>,
  ref: { readonly id: string; readonly originalStartUtc: number },
): Effect.Effect<AppleEventJson | undefined, AppleCalendarError> =>
  Effect.map(
    client.events({
      endUtc: ref.originalStartUtc + APPLE_OCCURRENCE_WINDOW_MS,
      startUtc: ref.originalStartUtc - APPLE_OCCURRENCE_WINDOW_MS,
    }),
    (nearby) => nearby.find((event) => isAppleOccurrence(event, ref)),
  );
