import { Temporal } from '@calendar/core';
import { Effect } from 'effect';
import type { AppleCalendarBridgeShape, AppleCalendarClientShape } from './client.ts';
import { type AppleCalendarError, isNotFound } from './errors.ts';
import { appleDetachedIdGuesses, appleSeriesId } from './identity.ts';
import { APPLE_WRITE_REACH_MS, type AppleEventJson, type OccurrenceRef } from './protocol.ts';

/**
 * An event as the app names it: an occurrence changed on its own goes
 * under its series' id. Anything else keeps EventKit's identifier — also
 * an event whose id ends in `/RID=` while EventKit does not count it as
 * detached (seen after a series was split): that is a single event, and
 * its id cut down would name the series' first occurrence.
 */
const underSeriesId = (event: AppleEventJson): AppleEventJson =>
  event.isDetached && event.occurrenceStartUtc !== undefined
    ? { ...event, id: appleSeriesId(event.id) }
    : event;

/** Whether `event` is the occurrence series `seriesId` drew at `slot`, changed on its own since. */
const isChangedAt = (event: AppleEventJson, seriesId: string, slot: number): boolean =>
  event.isDetached &&
  event.occurrenceStartUtc === slot &&
  event.id !== seriesId &&
  appleSeriesId(event.id) === seriesId;

/**
 * The bridge with one identity per series. EventKit names an occurrence
 * changed on its own by an identifier of its own (identity.ts), which the
 * bridge passes on untouched and compares literally. Here, under the real
 * bridge and the fake alike:
 *
 * - what is read names every occurrence by its series' id and its slot;
 * - a write by slot goes to the bridge as it is — that finds every
 *   occurrence the rule draws — and, when the bridge has nothing there,
 *   to the occurrence changed on its own, by the identifier EventKit
 *   knows it by. That identifier is not derivable from the slot: it is
 *   guessed and the guess is read back, then looked for in a range read
 *   around the slot.
 *
 * So an occurrence moved any distance is written like any other, unless
 * its identifier no longer names its slot (the series' time changed
 * since) and it sits further than `APPLE_WRITE_REACH_MS` from it: that
 * one answers `notFound`, as one that is gone does.
 *
 * An `id` without a slot passes through: it is EventKit's and names one
 * event. A batch is not looked up either (it writes single events).
 */
export const withSeriesIdentity = (
  bridge: AppleCalendarBridgeShape,
  deviceTimeZone: () => string = () => Temporal.Now.timeZoneId(),
): AppleCalendarClientShape => {
  const around = (slot: number) =>
    bridge.events({ endUtc: slot + APPLE_WRITE_REACH_MS, startUtc: slot - APPLE_WRITE_REACH_MS });

  /** The changed occurrence by a guessed identifier — wherever it sits — if that still names it. */
  const guessed = (
    seriesId: string,
    slot: number,
  ): Effect.Effect<AppleEventJson | undefined, AppleCalendarError> =>
    Effect.gen(function* () {
      for (const id of appleDetachedIdGuesses(seriesId, slot, deviceTimeZone())) {
        // `calendar.series` reads one event by exactly this identifier.
        const answer = yield* bridge.series({ id }).pipe(
          Effect.map((series): AppleEventJson | undefined => series.first),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );
        if (answer !== undefined && isChangedAt(answer, seriesId, slot)) {
          return answer;
        }
      }
      return undefined;
    });

  /**
   * A write by slot: first as the bridge takes it, then — the bridge found
   * nothing with the series' id there — to the occurrence changed on its
   * own. Nothing there either is the bridge's own `notFound`.
   */
  const bySlot = <A>(
    ref: { readonly id: string; readonly originalStartUtc: number },
    write: (ref: OccurrenceRef) => Effect.Effect<A, AppleCalendarError>,
  ): Effect.Effect<A, AppleCalendarError> => {
    const seriesId = appleSeriesId(ref.id);
    const slot = ref.originalStartUtc;
    return write({ id: seriesId, originalStartUtc: slot }).pipe(
      Effect.catchIf(isNotFound, (miss) =>
        Effect.gen(function* () {
          const changed =
            (yield* guessed(seriesId, slot)) ??
            (yield* around(slot)).find((event) => isChangedAt(event, seriesId, slot));
          return yield* changed === undefined ? Effect.fail(miss) : write({ id: changed.id });
        }),
      ),
    );
  };

  return {
    ...bridge,
    create: (params) => Effect.map(bridge.create(params), underSeriesId),
    delete: ({ ref, span }) => {
      const slot = ref.originalStartUtc;
      return slot === undefined
        ? bridge.delete({ ref, span })
        : bySlot({ id: ref.id, originalStartUtc: slot }, (found) =>
            bridge.delete({ ref: found, span }),
          );
    },
    events: (range) => Effect.map(bridge.events(range), (events) => events.map(underSeriesId)),
    move: (params) => Effect.map(bridge.move(params), underSeriesId),
    occurrence: ({ id, originalStartUtc: slot }) =>
      Effect.gen(function* () {
        const seriesId = appleSeriesId(id);
        const found =
          (yield* around(slot)).find(
            (event) =>
              event.occurrenceStartUtc === slot &&
              (event.id === seriesId || isChangedAt(event, seriesId, slot)),
          ) ?? (yield* guessed(seriesId, slot));
        return found === undefined ? undefined : underSeriesId(found);
      }),
    series: ({ id }) =>
      Effect.map(bridge.series({ id }), ({ first, rules }) => ({
        first: underSeriesId(first),
        rules,
      })),
    update: ({ changes, ref, span }) => {
      const slot = ref.originalStartUtc;
      return Effect.map(
        slot === undefined
          ? bridge.update({ changes, ref, span })
          : bySlot({ id: ref.id, originalStartUtc: slot }, (found) =>
              bridge.update({ changes, ref: found, span }),
            ),
        underSeriesId,
      );
    },
  };
};
