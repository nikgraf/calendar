import {
  AppleCalendarClient,
  type AppleCalendarClientShape,
  mapAppleEvent,
} from '@calendar/apple-calendar';
import { APPLE_CALENDAR_ACCOUNT_ID, type EventRecord, Temporal } from '@calendar/core';
import { AccountRepo, CalendarRepo } from '@calendar/db';
import { EVENTS_KEY } from '@calendar/db/keys';
import { Clock, Context, Effect, Layer, Stream } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';

/** EKEventStoreChanged arrives in bursts (iCloud sync, our own writes). */
const CHANGE_DEBOUNCE = '1 second';

export interface AppleCalendarEventsShape {
  /**
   * The Apple Calendar events overlapping [start, end), straight from
   * EventKit, limited to the mirrored calendars the user shows. Never
   * fails: no account, no access or no bridge simply means no events
   * (lost access also flags the account so the UI offers the way back).
   */
  readonly eventsInRange: (
    rangeStartUtc: number,
    rangeEndUtc: number,
  ) => Effect.Effect<ReadonlyArray<EventRecord>>;
  /** Repaints event views (after a write or a store change). */
  readonly invalidate: Effect.Effect<void>;
}

/** The device zone floating Apple events are read in. */
export const deviceTimeZone = (): string => Temporal.Now.timeZoneId();

/**
 * Apple events are read through, never stored: EventKit expands series
 * itself and already is a local database, so a mirror would only add a
 * window to maintain and a second copy that could disagree with
 * Calendar.app. Every read asks EventKit, deliberately without a cache:
 * EventKit is local and fast, and a range memo invites the race where a
 * read that started before a write stores its stale answer after the
 * write cleared the memo. `EKEventStoreChanged` invalidates EVENTS_KEY,
 * which is how an edit in Calendar.app reaches the UI.
 */
const make: Effect.Effect<
  AppleCalendarEventsShape,
  never,
  AccountRepo | AppleCalendarClient | CalendarRepo | Reactivity
> = Effect.gen(function* () {
  const client: AppleCalendarClientShape = yield* AppleCalendarClient;
  const accountRepo = yield* AccountRepo;
  const calendarRepo = yield* CalendarRepo;
  const reactivity = yield* Reactivity;
  const invalidate = Effect.ignore(reactivity.invalidate([EVENTS_KEY]));

  const eventsInRange = (rangeStartUtc: number, rangeEndUtc: number) =>
    Effect.gen(function* () {
      const account = yield* accountRepo.get(APPLE_CALENDAR_ACCOUNT_ID);
      if (!account || account.status !== 'ok') {
        return [];
      }
      const visible = new Set(
        (yield* calendarRepo.list(APPLE_CALENDAR_ACCOUNT_ID))
          .filter((calendar) => calendar.isVisible)
          .map((calendar) => calendar.id),
      );
      if (visible.size === 0) {
        return [];
      }
      const events = yield* client.events({ endUtc: rangeEndUtc, startUtc: rangeStartUtc });
      const now = yield* Clock.currentTimeMillis;
      const zone = deviceTimeZone();
      return events
        .filter((event) => visible.has(event.calendarId))
        .map((event) => mapAppleEvent(event, { deviceTimeZone: zone, now }));
    }).pipe(
      Effect.catchTag('AppleCalendarAccessError', () =>
        Effect.as(
          Effect.ignore(accountRepo.setStatus(APPLE_CALENDAR_ACCOUNT_ID, 'reauth_required')),
          [],
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.as(Effect.logWarning('apple calendar events unavailable', { cause }), []),
      ),
    );

  yield* Effect.forkDetach(
    client.changes.pipe(
      Stream.debounce(CHANGE_DEBOUNCE),
      Stream.runForEach(() => invalidate),
    ),
  );

  return { eventsInRange, invalidate };
});

export class AppleCalendarEvents extends Context.Service<
  AppleCalendarEvents,
  AppleCalendarEventsShape
>()('sync/AppleCalendarEvents') {
  static readonly layer: Layer.Layer<
    AppleCalendarEvents,
    never,
    AccountRepo | AppleCalendarClient | CalendarRepo | Reactivity
  > = Layer.effect(AppleCalendarEvents)(make);
}

/** The Apple Calendar client + its read path, for hosts and test recipes. */
export const appleCalendarServicesLayer = (
  client: AppleCalendarClientShape,
): Layer.Layer<
  AppleCalendarClient | AppleCalendarEvents,
  never,
  AccountRepo | CalendarRepo | Reactivity
> => AppleCalendarEvents.layer.pipe(Layer.provideMerge(Layer.succeed(AppleCalendarClient, client)));
