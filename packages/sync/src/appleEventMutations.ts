import {
  type AppleCalendarClientShape,
  type AppleCalendarError,
  draftToEventWrite,
  type EventWrite,
  isNotFound,
  mapAppleEvent,
  type Span,
  toEventWrite,
} from '@calendar/apple-calendar';
import { applyWallClockDelta, normalizeHexColor } from '@calendar/core';
import type { AccountRepoShape, CalendarRepoShape } from '@calendar/db';
import { Clock, Effect } from 'effect';
import type { AppleCalendarEventsShape } from './appleCalendarEvents.ts';
import { deviceTimeZone } from './appleCalendarEvents.ts';
import {
  type EventMutationsShape,
  InvalidColorError,
  type UpdateEventParams,
  UnsupportedForProviderError,
} from './mutationTypes.ts';

/**
 * The Apple Calendar half of the event mutations. EventKit is local and
 * synchronous, so — like Reminders — there is no optimistic row and no
 * pending op: each call writes EventKit and is done. Unlike Reminders
 * nothing is mirrored either (Apple events are read through), so a write
 * ends by invalidating the event views instead.
 *
 * Recurring scopes map onto EventKit's spans: `instance` saves one
 * occurrence with `thisEvent` (EventKit detaches it), `following` saves
 * the occurrence with `futureEvents` (EventKit splits the series there),
 * `series` saves the first occurrence with `futureEvents`.
 */
export interface AppleEventMutationDeps {
  readonly accountRepo: AccountRepoShape;
  readonly appleEvents: AppleCalendarEventsShape;
  readonly calendarRepo: CalendarRepoShape;
  readonly client: AppleCalendarClientShape;
}

export type AppleEventMutations = Pick<
  EventMutationsShape,
  | 'createEvent'
  | 'deleteEvent'
  | 'deleteRecurring'
  | 'respondToEvent'
  | 'setCalendarColor'
  | 'updateEvent'
  | 'updateRecurring'
> & {
  /** Re-homes a single event or a whole series inside the EventKit store. */
  readonly moveWithin: (params: {
    readonly calendarId: string;
    readonly id: string;
  }) => Effect.Effect<void, AppleCalendarError>;
};

/** Guests cannot be written through EventKit — never drop them silently. */
const rejectGuests = (changes: UpdateEventParams['changes']) =>
  changes.attendees === undefined
    ? Effect.void
    : Effect.fail(new UnsupportedForProviderError({ field: 'attendees', provider: 'apple' }));

/** A delete of something EventKit no longer has has nothing left to do. */
const goneIsDone = (effect: Effect.Effect<void, AppleCalendarError>) =>
  Effect.catchIf(effect, isNotFound, () => Effect.void);

const record = (json: Parameters<typeof mapAppleEvent>[0]) =>
  Effect.map(Clock.currentTimeMillis, (now) =>
    mapAppleEvent(json, { deviceTimeZone: deviceTimeZone(), now }),
  );

export const makeAppleEventMutations = (deps: AppleEventMutationDeps): AppleEventMutations => {
  const { accountRepo, appleEvents, calendarRepo, client } = deps;

  /** Lost access mid-flight: flag the account so the UI offers the way back. */
  const flagAccessLoss =
    (accountId: string) =>
    <A, E extends { readonly _tag: string }, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.tapError(effect, (error) =>
        error._tag === 'AppleCalendarAccessError'
          ? Effect.ignore(accountRepo.setStatus(accountId, 'reauth_required'))
          : Effect.void,
      );

  /** Every committed write repaints the views that read EventKit live. */
  const thenInvalidate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.tap(effect, () => appleEvents.invalidate);

  return {
    createEvent: (draft) =>
      Effect.gen(function* () {
        if (draft.attendees !== undefined && draft.attendees.length > 0) {
          return yield* Effect.fail(
            new UnsupportedForProviderError({ field: 'attendees', provider: 'apple' }),
          );
        }
        const converted = draftToEventWrite(draft, deviceTimeZone());
        if (converted._tag === 'unsupported') {
          return yield* Effect.fail(
            new UnsupportedForProviderError({
              field: `recurrence (${converted.parts.join(', ')})`,
              provider: 'apple',
            }),
          );
        }
        const created = yield* client.create({
          calendarId: draft.calendarId,
          event: converted.write,
        });
        return yield* record(created);
      }).pipe(thenInvalidate, flagAccessLoss(draft.accountId)),

    deleteEvent: ({ accountId, eventId }) =>
      goneIsDone(client.delete({ ref: { id: eventId }, span: 'thisEvent' })).pipe(
        thenInvalidate,
        flagAccessLoss(accountId),
      ),

    deleteRecurring: ({ accountId, masterId, originalStartUtc, scope }) =>
      goneIsDone(
        scope === 'series'
          ? // The series identifier alone resolves to its first occurrence.
            client.delete({ ref: { id: masterId }, span: 'futureEvents' })
          : client.delete({
              ref: { id: masterId, originalStartUtc },
              span: scope === 'instance' ? 'thisEvent' : 'futureEvents',
            }),
      ).pipe(thenInvalidate, flagAccessLoss(accountId)),

    moveWithin: ({ calendarId, id }) =>
      Effect.asVoid(client.move({ calendarId, id })).pipe(thenInvalidate),

    respondToEvent: () =>
      Effect.fail(new UnsupportedForProviderError({ field: 'rsvp', provider: 'apple' })),

    setCalendarColor: ({ accountId, calendarId, colorHex }) =>
      Effect.gen(function* () {
        const normalized = normalizeHexColor(colorHex);
        if (!normalized) {
          return yield* Effect.fail(new InvalidColorError({ colorHex }));
        }
        yield* client.setColor({ calendarId, colorHex: normalized });
        // The next calendar pass re-reads the color anyway; this shows it now.
        yield* Effect.ignore(calendarRepo.setColor(accountId, calendarId, normalized));
      }).pipe(thenInvalidate, flagAccessLoss(accountId)),

    updateEvent: ({ accountId, changes, eventId }) =>
      Effect.gen(function* () {
        yield* rejectGuests(changes);
        yield* client.update({
          changes: toEventWrite(changes),
          ref: { id: eventId },
          span: 'thisEvent',
        });
      }).pipe(thenInvalidate, flagAccessLoss(accountId)),

    updateRecurring: ({ accountId, changes, masterId, originalStartUtc, scope }) =>
      Effect.gen(function* () {
        yield* rejectGuests(changes);
        if (scope !== 'series') {
          yield* client.update({
            changes: toEventWrite(changes),
            ref: { id: masterId, originalStartUtc },
            span: scope === 'instance' ? 'thisEvent' : 'futureEvents',
          });
          return;
        }
        // The whole series: write the first occurrence with futureEvents.
        // A time edit made on some occurrence shifts the series start by
        // that occurrence's wall-clock delta (DST-safe), exactly like the
        // Google series path; all-day series take non-time fields only.
        const series = yield* client.series({ id: masterId });
        const first = series.first;
        const firstSlot = first.occurrenceStartUtc ?? first.startUtc;
        const {
          endDate: _endDate,
          endUtc,
          isAllDay: _isAllDay,
          startDate: _startDate,
          startUtc,
          ...rest
        } = changes;
        let write: EventWrite = toEventWrite(rest);
        if (!first.isAllDay && startUtc !== undefined) {
          const zone = first.timeZone ?? deviceTimeZone();
          const shifted = applyWallClockDelta(first.startUtc, zone, originalStartUtc, startUtc);
          const duration = endUtc === undefined ? first.endUtc - first.startUtc : endUtc - startUtc;
          write = { ...write, endUtc: shifted + duration, startUtc: shifted };
        }
        yield* client.update({
          changes: write,
          ref: { id: masterId, originalStartUtc: firstSlot },
          span: 'futureEvents' satisfies Span,
        });
      }).pipe(thenInvalidate, flagAccessLoss(accountId)),
  };
};
