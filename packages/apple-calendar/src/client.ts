import { type BridgeTransport, bridgeMessage, changesFromSubscription } from '@calendar/core';
import { Context, Data, Effect, Layer, Schema, Stream } from 'effect';
import {
  APPLE_CALENDAR_METHODS,
  type AppleCalendarJson,
  type AppleEventJson,
  type CalendarAuthorization,
  EventResult,
  EventsResult,
  type EventWrite,
  ListCalendarsResult,
  type OccurrenceRef,
  RequestAccessResult,
  SeriesResult,
  type Span,
  StatusResult,
} from './protocol.ts';

/** EventKit events access is missing (denied/restricted/not asked yet). */
export class AppleCalendarAccessError extends Data.TaggedError('AppleCalendarAccessError')<{
  readonly authorization: CalendarAuthorization;
}> {}

/** No native calendar bridge on this build/platform (helper missing, module absent, kill switch). */
export class AppleCalendarUnavailableError extends Data.TaggedError(
  'AppleCalendarUnavailableError',
)<{
  readonly message: string;
}> {}

/** The bridge answered with an error (save failure, unknown id, read-only calendar…). */
export class AppleCalendarRequestError extends Data.TaggedError('AppleCalendarRequestError')<{
  readonly message: string;
  readonly method: string;
}> {}

export type AppleCalendarError =
  | AppleCalendarAccessError
  | AppleCalendarRequestError
  | AppleCalendarUnavailableError;

/** The event (or occurrence) is gone — a delete of it has nothing left to do. */
export const isNotFound = (error: AppleCalendarError): boolean =>
  error._tag === 'AppleCalendarRequestError' && error.message.startsWith('notFound:');

const AUTHORIZATIONS: ReadonlySet<string> = new Set([
  'denied',
  'fullAccess',
  'notDetermined',
  'restricted',
  'unavailable',
  'writeOnly',
]);
const isAuthorization = (value: string): value is CalendarAuthorization =>
  AUTHORIZATIONS.has(value);

export interface AppleCalendarClientShape {
  /**
   * Fires whenever EventKit's database changed (any app, any item). The
   * backend holds no Apple event rows, so this is what repaints the UI
   * after an edit in Calendar.app; it reaches a live observer only.
   */
  readonly changes: Stream.Stream<void>;
  readonly create: (params: {
    readonly calendarId: string;
    readonly event: EventWrite;
  }) => Effect.Effect<AppleEventJson, AppleCalendarError>;
  readonly delete: (params: {
    readonly ref: OccurrenceRef;
    readonly span: Span;
  }) => Effect.Effect<void, AppleCalendarError>;
  /** Every event and occurrence overlapping [startUtc, endUtc), across all calendars. */
  readonly events: (params: {
    readonly endUtc: number;
    readonly startUtc: number;
  }) => Effect.Effect<ReadonlyArray<AppleEventJson>, AppleCalendarError>;
  readonly listCalendars: () => Effect.Effect<ReadonlyArray<AppleCalendarJson>, AppleCalendarError>;
  /** Moves a single event, or a whole series, to another calendar of the store. */
  readonly move: (params: {
    readonly calendarId: string;
    readonly id: string;
  }) => Effect.Effect<AppleEventJson, AppleCalendarError>;
  /** Triggers the OS prompt when undetermined; resolves to the outcome. */
  readonly requestAccess: () => Effect.Effect<boolean, AppleCalendarError>;
  readonly series: (params: {
    readonly id: string;
  }) => Effect.Effect<SeriesResult, AppleCalendarError>;
  readonly setColor: (params: {
    readonly calendarId: string;
    readonly colorHex: string;
  }) => Effect.Effect<void, AppleCalendarError>;
  readonly status: () => Effect.Effect<CalendarAuthorization, AppleCalendarError>;
  readonly update: (params: {
    readonly changes: EventWrite;
    readonly ref: OccurrenceRef;
    readonly span: Span;
  }) => Effect.Effect<AppleEventJson, AppleCalendarError>;
}

export class AppleCalendarClient extends Context.Service<
  AppleCalendarClient,
  AppleCalendarClientShape
>()('apple-calendar/AppleCalendarClient') {}

const refParams = (ref: OccurrenceRef): Record<string, unknown> =>
  ref.originalStartUtc === undefined
    ? { id: ref.id }
    : { id: ref.id, originalStartUtc: ref.originalStartUtc };

/**
 * A transport-agnostic implementation over "send a method + JSON params,
 * get JSON back": the desktop helper stdio call and the iOS Expo module
 * both fit, so each platform only supplies `invoke`.
 */
export const makeAppleCalendarClient = (
  invoke: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  changes: Stream.Stream<void> = Stream.empty,
): AppleCalendarClientShape => {
  const call = <A, I>(
    method: string,
    result: Schema.Codec<A, I>,
    params?: Record<string, unknown>,
  ): Effect.Effect<A, AppleCalendarError> =>
    Effect.tryPromise({
      catch: (error): AppleCalendarError => {
        const message = bridgeMessage(error instanceof Error ? error.message : String(error));
        if (message.startsWith('accessDenied: ')) {
          const status = message.slice('accessDenied: '.length);
          return new AppleCalendarAccessError({
            authorization: isAuthorization(status) ? status : 'denied',
          });
        }
        if (message.includes('helper unavailable')) {
          return new AppleCalendarUnavailableError({ message });
        }
        return new AppleCalendarRequestError({ message, method });
      },
      try: () => invoke(method, params),
    }).pipe(
      Effect.flatMap((raw) =>
        Schema.decodeUnknownEffect(result)(raw).pipe(
          Effect.mapError(
            (error) =>
              new AppleCalendarRequestError({ message: `bad response: ${String(error)}`, method }),
          ),
        ),
      ),
    );

  return {
    changes,
    create: ({ calendarId, event }) =>
      Effect.map(
        call(APPLE_CALENDAR_METHODS.create, EventResult, { calendarId, event }),
        (r) => r.event,
      ),
    delete: ({ ref, span }) =>
      Effect.asVoid(
        call(APPLE_CALENDAR_METHODS.delete, Schema.Unknown, { ...refParams(ref), span }),
      ),
    events: ({ endUtc, startUtc }) =>
      Effect.map(
        call(APPLE_CALENDAR_METHODS.events, EventsResult, { endUtc, startUtc }),
        (r) => r.events,
      ),
    listCalendars: () =>
      Effect.map(
        call(APPLE_CALENDAR_METHODS.listCalendars, ListCalendarsResult),
        (r) => r.calendars,
      ),
    move: ({ calendarId, id }) =>
      Effect.map(
        call(APPLE_CALENDAR_METHODS.move, EventResult, { calendarId, id }),
        (r) => r.event,
      ),
    requestAccess: () =>
      Effect.map(call(APPLE_CALENDAR_METHODS.requestAccess, RequestAccessResult), (r) => r.granted),
    series: ({ id }) => call(APPLE_CALENDAR_METHODS.series, SeriesResult, { id }),
    setColor: ({ calendarId, colorHex }) =>
      Effect.asVoid(
        call(APPLE_CALENDAR_METHODS.setColor, Schema.Unknown, { calendarId, colorHex }),
      ),
    status: () =>
      Effect.map(call(APPLE_CALENDAR_METHODS.status, StatusResult), (r) => r.authorization),
    update: ({ changes, ref, span }) =>
      Effect.map(
        call(APPLE_CALENDAR_METHODS.update, EventResult, { ...refParams(ref), changes, span }),
        (r) => r.event,
      ),
  };
};

/**
 * Every method fails with AppleCalendarUnavailableError — the client for
 * builds without a bridge (tests, e2e, a desktop without the helper).
 * `status` reports 'unavailable' instead of failing so UIs can render it.
 */
export const unavailableAppleCalendarClient = (reason: string): AppleCalendarClientShape => {
  const fail = <A>(): Effect.Effect<A, AppleCalendarError> =>
    Effect.fail(new AppleCalendarUnavailableError({ message: reason }));
  return {
    changes: Stream.empty,
    create: () => fail(),
    delete: () => fail(),
    events: () => fail(),
    listCalendars: () => fail(),
    move: () => fail(),
    requestAccess: () => fail(),
    series: () => fail(),
    setColor: () => fail(),
    status: () => Effect.succeed('unavailable' as const),
    update: () => fail(),
  };
};

/** The helper's / module's change event for this bridge. */
export const APPLE_CALENDAR_CHANGED_EVENT = 'calendar.changed';

export const appleCalendarClientFrom = (
  source: BridgeTransport | { readonly unavailable: string },
): AppleCalendarClientShape =>
  'unavailable' in source
    ? unavailableAppleCalendarClient(source.unavailable)
    : makeAppleCalendarClient(
        source.invoke,
        changesFromSubscription((listener) =>
          source.subscribe(APPLE_CALENDAR_CHANGED_EVENT, listener),
        ),
      );

export const appleCalendarLayer = (
  source: BridgeTransport | { readonly unavailable: string },
): Layer.Layer<AppleCalendarClient> =>
  Layer.succeed(AppleCalendarClient, appleCalendarClientFrom(source));
