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
import {
  applyWallClockDelta,
  type EventReminders,
  normalizeHexColor,
  toStructuredRules,
} from '@calendar/core';
import type { AccountRepoShape, CalendarRepoShape } from '@calendar/db';
import { Clock, Effect } from 'effect';
import type { AppleCalendarEventsShape } from './appleCalendarEvents.ts';
import { deviceTimeZone } from './appleCalendarEvents.ts';
import {
  type EventMutationsShape,
  InvalidColorError,
  RecurringAllDaySwitchError,
  RecurringEditUnsupportedError,
  type UpdateEventParams,
  UnsupportedForProviderError,
} from './mutationTypes.ts';

/**
 * The rule part of an edit as the bridge takes it: null clears the series,
 * lines convert to structured rules — or are refused when EventKit cannot
 * hold a part (an EXDATE, a BYHOUR), never silently narrowed.
 */
const ruleWrite = (
  changes: UpdateEventParams['changes'],
  first: { readonly isAllDay: boolean; readonly timeZone?: string | undefined },
): Effect.Effect<Pick<EventWrite, 'recurrence'>, UnsupportedForProviderError> =>
  Effect.gen(function* () {
    if (changes.recurrence === undefined) {
      return {};
    }
    if (changes.recurrence === null) {
      return { recurrence: null };
    }
    const converted = toStructuredRules(
      changes.recurrence,
      first.isAllDay,
      first.timeZone ?? deviceTimeZone(),
    );
    if (converted.unsupported.length > 0) {
      return yield* Effect.fail(
        new UnsupportedForProviderError({
          field: `recurrence (${converted.unsupported.join(', ')})`,
          provider: 'apple',
        }),
      );
    }
    return { recurrence: converted.rules };
  });

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
    readonly accountId: string;
    readonly calendarId: string;
    readonly id: string;
  }) => Effect.Effect<void, AppleCalendarError>;
};

/** Guests cannot be written through EventKit — never drop them silently. */
const rejectGuests = (changes: UpdateEventParams['changes']) =>
  changes.attendees === undefined
    ? Effect.void
    : Effect.fail(new UnsupportedForProviderError({ field: 'attendees', provider: 'apple' }));

/**
 * EventKit alarms are explicit popups: no "calendar default" and no
 * email. Either would be dropped silently by the bridge, so refuse.
 */
const rejectUnsupportedReminders = (reminders: EventReminders | undefined) =>
  reminders === undefined
    ? Effect.void
    : reminders.useDefault
      ? Effect.fail(
          new UnsupportedForProviderError({ field: 'reminders.useDefault', provider: 'apple' }),
        )
      : reminders.overrides.some((override) => override.method === 'email')
        ? Effect.fail(
            new UnsupportedForProviderError({ field: 'reminders.email', provider: 'apple' }),
          )
        : Effect.void;

/** A delete of something EventKit no longer has has nothing left to do. */
const goneIsDone = (effect: Effect.Effect<void, AppleCalendarError>) =>
  Effect.catchIf(effect, isNotFound, (error) =>
    Effect.logWarning('apple calendar delete: already gone', { message: error.message }),
  );

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
        yield* rejectUnsupportedReminders(draft.reminders);
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

    moveWithin: ({ accountId, calendarId, id }) =>
      Effect.asVoid(client.move({ calendarId, id })).pipe(
        thenInvalidate,
        flagAccessLoss(accountId),
      ),

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
        yield* rejectUnsupportedReminders(changes.reminders);
        if (changes.recurrence !== undefined) {
          // A single event does not become a series through an update.
          return yield* Effect.fail(new RecurringEditUnsupportedError({ eventId }));
        }
        yield* client.update({
          changes: toEventWrite(changes),
          ref: { id: eventId },
          span: 'thisEvent',
        });
      }).pipe(thenInvalidate, flagAccessLoss(accountId)),

    updateRecurring: ({ accountId, changes, masterId, originalStartUtc, scope }) =>
      Effect.gen(function* () {
        yield* rejectGuests(changes);
        yield* rejectUnsupportedReminders(changes.reminders);
        if (scope === 'instance' && changes.recurrence !== undefined) {
          // One occurrence cannot carry its own rule.
          return yield* Effect.fail(new RecurringEditUnsupportedError({ eventId: masterId }));
        }
        // The series keeps its kind, like a Google one (RecurringAllDaySwitchError).
        // A rule edit needs the series too: its kind and zone shape the rules.
        const series =
          scope === 'series' || changes.isAllDay !== undefined || changes.recurrence !== undefined
            ? yield* client.series({ id: masterId })
            : undefined;
        if (changes.isAllDay !== undefined && changes.isAllDay !== series?.first.isAllDay) {
          return yield* Effect.fail(new RecurringAllDaySwitchError({ eventId: masterId }));
        }
        if (scope !== 'series' || !series) {
          const rule = series ? yield* ruleWrite(changes, series.first) : {};
          yield* client.update({
            changes: { ...toEventWrite(changes), ...rule },
            ref: { id: masterId, originalStartUtc },
            span: scope === 'instance' ? 'thisEvent' : 'futureEvents',
          });
          return;
        }
        // The whole series: write the first occurrence with futureEvents.
        // A time edit made on some occurrence shifts the series start by
        // that occurrence's wall-clock delta (DST-safe), exactly like the
        // Google series path; all-day series take non-time fields only (the
        // editor and the agent gateway refuse a new date before it gets here:
        // an EventKit slot is a device-local midnight, so only they know the
        // date the occurrence showed).
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
        let write: EventWrite = { ...toEventWrite(rest), ...(yield* ruleWrite(changes, first)) };
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
