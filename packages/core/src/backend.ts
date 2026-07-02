import { Cause, Effect, Schema } from 'effect';
import { Account, CalendarInfo, EventRecord } from './types.ts';

/**
 * The platform seam: every UI talks to the backend exclusively through this
 * Schema-typed method map. iOS implements it in-process; Electron serves it
 * from the main process over a preload bridge. Payloads and results cross the
 * bridge in encoded form, so both sides stay validated.
 */
export const EventDraft = Schema.Struct({
  accountId: Schema.String,
  calendarId: Schema.String,
  description: Schema.optional(Schema.String),
  /** All-day drafts use dates; timed drafts use epochs + zone. */
  endDate: Schema.optional(Schema.String),
  endUtc: Schema.Number,
  isAllDay: Schema.Boolean,
  location: Schema.optional(Schema.String),
  startDate: Schema.optional(Schema.String),
  startTimeZone: Schema.optional(Schema.String),
  startUtc: Schema.Number,
  title: Schema.String,
});
export type EventDraft = Schema.Schema.Type<typeof EventDraft>;

export const backendMethods = {
  addAccount: {
    payload: Schema.Void,
    success: Account,
  },
  createEvent: {
    payload: EventDraft,
    success: EventRecord,
  },
  deleteEvent: {
    payload: Schema.Struct({
      accountId: Schema.String,
      calendarId: Schema.String,
      eventId: Schema.String,
    }),
    success: Schema.Void,
  },
  /** Materialized (recurrence-expanded) events of visible calendars. */
  getEventsInRange: {
    payload: Schema.Struct({
      rangeEndUtc: Schema.Number,
      rangeStartUtc: Schema.Number,
    }),
    success: Schema.Array(EventRecord),
  },
  listAccounts: {
    payload: Schema.Void,
    success: Schema.Array(Account),
  },
  listCalendars: {
    payload: Schema.Struct({
      accountId: Schema.optional(Schema.String),
    }),
    success: Schema.Array(CalendarInfo),
  },
  removeAccount: {
    payload: Schema.Struct({ accountId: Schema.String }),
    success: Schema.Void,
  },
  setCalendarVisible: {
    payload: Schema.Struct({
      accountId: Schema.String,
      calendarId: Schema.String,
      isVisible: Schema.Boolean,
    }),
    success: Schema.Void,
  },
  /** Kicks a sync pass; resolves when the pass completes. */
  syncNow: {
    payload: Schema.Void,
    success: Schema.Void,
  },
  updateEvent: {
    payload: Schema.Struct({
      accountId: Schema.String,
      calendarId: Schema.String,
      changes: Schema.Struct({
        description: Schema.optional(Schema.String),
        endDate: Schema.optional(Schema.String),
        endUtc: Schema.optional(Schema.Number),
        isAllDay: Schema.optional(Schema.Boolean),
        location: Schema.optional(Schema.String),
        startDate: Schema.optional(Schema.String),
        startUtc: Schema.optional(Schema.Number),
        title: Schema.optional(Schema.String),
      }),
      eventId: Schema.String,
    }),
    success: Schema.Void,
  },
} as const;

export type BackendMethods = typeof backendMethods;
export type BackendMethodName = keyof BackendMethods;

export type BackendPayload<M extends BackendMethodName> = Schema.Schema.Type<
  BackendMethods[M]['payload']
>;
export type BackendSuccess<M extends BackendMethodName> = Schema.Schema.Type<
  BackendMethods[M]['success']
>;

/** Wire format of a failed backend call. */
export class BackendError extends Schema.ErrorClass<BackendError>('core/BackendError')({
  message: Schema.String,
  tag: Schema.String,
}) {}

/** What the preload bridge exposes to the renderer. */
export interface BackendTransport {
  readonly invoke: (method: string, payload: unknown) => Promise<unknown>;
  /** Fires when backend data changed; returns an unsubscribe function. */
  readonly onChanged?: (listener: () => void) => () => void;
}

const encodedResult = Schema.Struct({
  error: Schema.optional(Schema.Struct({ message: Schema.String, tag: Schema.String })),
  value: Schema.optional(Schema.Unknown),
});

export type BackendClient = {
  readonly [M in BackendMethodName]: (
    payload: BackendPayload<M>,
  ) => Effect.Effect<BackendSuccess<M>, BackendError>;
};

/** Builds the renderer-side typed client over a transport. */
export const makeBackendClient = (transport: BackendTransport): BackendClient => {
  const method = <M extends BackendMethodName>(name: M) => {
    const codecs = backendMethods[name];
    return (payload: BackendPayload<M>): Effect.Effect<BackendSuccess<M>, BackendError> =>
      Effect.gen(function* () {
        const encodedPayload = yield* Schema.encodeUnknownEffect(
          codecs.payload as Schema.Codec<unknown, unknown>,
        )(payload).pipe(
          Effect.catchCause((cause) =>
            Effect.fail(
              new BackendError({
                message: String(cause),
                tag: 'EncodeError',
              }),
            ),
          ),
        );
        const raw = yield* Effect.tryPromise({
          catch: (cause) => new BackendError({ message: String(cause), tag: 'BridgeError' }),
          try: () => transport.invoke(name, encodedPayload),
        });
        const result = yield* Schema.decodeUnknownEffect(encodedResult)(raw).pipe(
          Effect.catchCause((cause) =>
            Effect.fail(
              new BackendError({
                message: String(cause),
                tag: 'DecodeError',
              }),
            ),
          ),
        );
        if (result.error) {
          return yield* Effect.fail(
            new BackendError({
              message: result.error.message,
              tag: result.error.tag,
            }),
          );
        }
        return yield* Schema.decodeUnknownEffect(
          codecs.success as Schema.Codec<BackendSuccess<M>, unknown>,
        )(result.value).pipe(
          Effect.catchCause((cause) =>
            Effect.fail(
              new BackendError({
                message: String(cause),
                tag: 'DecodeError',
              }),
            ),
          ),
        );
      });
  };

  return {
    addAccount: method('addAccount'),
    createEvent: method('createEvent'),
    deleteEvent: method('deleteEvent'),
    getEventsInRange: method('getEventsInRange'),
    listAccounts: method('listAccounts'),
    listCalendars: method('listCalendars'),
    removeAccount: method('removeAccount'),
    setCalendarVisible: method('setCalendarVisible'),
    syncNow: method('syncNow'),
    updateEvent: method('updateEvent'),
  };
};

/**
 * In-process client: wraps handlers directly (no serialization hop) — used on
 * iOS where the backend runs inside the app.
 */
export const makeDirectBackendClient = <R>(
  handlers: BackendHandlers<R>,
  run: <A>(effect: Effect.Effect<A, unknown, R>) => Promise<A>,
): BackendClient => {
  const method = <M extends BackendMethodName>(name: M) => {
    return (payload: BackendPayload<M>): Effect.Effect<BackendSuccess<M>, BackendError> =>
      Effect.tryPromise({
        catch: (error) => {
          const tag =
            typeof error === 'object' && error !== null && '_tag' in error
              ? String((error as { _tag: unknown })._tag)
              : 'UnknownError';
          return new BackendError({ message: String(error), tag });
        },
        try: () => run(handlers[name](payload as never)),
      }) as Effect.Effect<BackendSuccess<M>, BackendError>;
  };
  return {
    addAccount: method('addAccount'),
    createEvent: method('createEvent'),
    deleteEvent: method('deleteEvent'),
    getEventsInRange: method('getEventsInRange'),
    listAccounts: method('listAccounts'),
    listCalendars: method('listCalendars'),
    removeAccount: method('removeAccount'),
    setCalendarVisible: method('setCalendarVisible'),
    syncNow: method('syncNow'),
    updateEvent: method('updateEvent'),
  };
};

/**
 * Host-side handler map: the backend implements each method as an Effect;
 * `handleBackendInvoke` encodes results/errors into the wire format.
 */
export type BackendHandlers<R = never> = {
  readonly [M in BackendMethodName]: (
    payload: BackendPayload<M>,
  ) => Effect.Effect<BackendSuccess<M>, unknown, R>;
};

export const handleBackendInvoke = <R>(
  handlers: BackendHandlers<R>,
  method: string,
  rawPayload: unknown,
): Effect.Effect<{ error?: { message: string; tag: string }; value?: unknown }, never, R> =>
  Effect.gen(function* () {
    if (!(method in backendMethods)) {
      return { error: { message: `unknown method ${method}`, tag: 'Unknown' } };
    }
    const name = method as BackendMethodName;
    const codecs = backendMethods[name];

    return yield* Schema.decodeUnknownEffect(codecs.payload as Schema.Codec<unknown, unknown>)(
      rawPayload,
    ).pipe(
      Effect.flatMap((payload) =>
        handlers[name](payload as never).pipe(
          Effect.flatMap((value) =>
            Schema.encodeUnknownEffect(codecs.success as Schema.Codec<unknown, unknown>)(value),
          ),
          Effect.map((value) => ({ value })),
        ),
      ),
      Effect.catchCause((cause) => {
        const failure = cause.reasons.find((reason) => Cause.isFailReason(reason));
        const error = failure?.error;
        const tag =
          typeof error === 'object' && error !== null && '_tag' in error
            ? String((error as { _tag: unknown })._tag)
            : 'UnknownError';
        return Effect.succeed({
          error: { message: String(error ?? cause), tag },
        });
      }),
    );
  });
