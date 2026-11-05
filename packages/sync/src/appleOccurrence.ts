import type {
  AppleCalendarClientShape,
  AppleCalendarError,
  AppleEventJson,
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
 * by its slot reaches it (`AppleCalendarClientShape.occurrence`);
 * undefined when it is gone, cancelled, or out of that reach.
 */
export const findAppleOccurrence = (
  client: Pick<AppleCalendarClientShape, 'occurrence'>,
  ref: { readonly id: string; readonly originalStartUtc: number },
): Effect.Effect<AppleEventJson | undefined, AppleCalendarError> =>
  Effect.map(client.occurrence(ref), (found) =>
    found === undefined || found.status === 'cancelled' ? undefined : found,
  );

/** EventKit matches four years per predicate; the count looks through the series' first four. */
const MODIFIED_WINDOW_MS = 4 * 365 * 24 * 60 * 60 * 1000;

/**
 * How many occurrences of a series were changed on their own, among what
 * EventKit draws in the four years from its first slot: what a copy to
 * another account drops. One changed occurrence that was moved to before
 * that slot is not seen; a cancelled one is not drawn and not counted.
 * One range read across every calendar, so only a move or conversion
 * preview asks (`loadSource`). (The bridge's own `detachedCount` compares
 * the series id with identifiers that never equal it; it is 0 on a real
 * store.)
 */
export const countAppleChangedOccurrences = (
  client: Pick<AppleCalendarClientShape, 'events'>,
  first: AppleEventJson,
): Effect.Effect<number, AppleCalendarError> => {
  const startUtc = first.occurrenceStartUtc ?? first.startUtc;
  return Effect.map(
    client.events({ endUtc: startUtc + MODIFIED_WINDOW_MS, startUtc }),
    (events) =>
      events.filter(
        (event) => event.id === first.id && event.isDetached && event.status !== 'cancelled',
      ).length,
  );
};
