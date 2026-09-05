import { Context, Data, Effect, Queue, Schema, Stream } from 'effect';
import {
  ListListsResult,
  type ReminderJson,
  type ReminderListJson,
  type RemindersAuthorization,
  ReminderResult,
  type ReminderWrite,
  REMINDERS_METHODS,
  RequestAccessResult,
  SnapshotResult,
  StatusResult,
} from './protocol.ts';

/** EventKit access is missing (denied/restricted/not asked yet). */
export class RemindersAccessError extends Data.TaggedError('RemindersAccessError')<{
  readonly authorization: RemindersAuthorization;
}> {}

/** No native Reminders bridge on this build/platform (helper missing, module absent). */
export class RemindersUnavailableError extends Data.TaggedError('RemindersUnavailableError')<{
  readonly message: string;
}> {}

/** The bridge answered with an error (EventKit save failure, bad id, …). */
export class RemindersRequestError extends Data.TaggedError('RemindersRequestError')<{
  readonly message: string;
  readonly method: string;
}> {}

export type RemindersError =
  | RemindersAccessError
  | RemindersRequestError
  | RemindersUnavailableError;

const AUTHORIZATIONS: ReadonlySet<string> = new Set([
  'denied',
  'fullAccess',
  'notDetermined',
  'restricted',
  'unavailable',
  'writeOnly',
]);
const isAuthorization = (value: string): value is RemindersAuthorization =>
  AUTHORIZATIONS.has(value);

/**
 * The bridge's own message, whatever the transport wrapped around it. The
 * helper emits it verbatim; expo-modules-core rethrows it as
 * "FunctionCallException: … → Caused by: RemindersBridgeError: <message>",
 * so take the last "Caused by:" segment and strip the exception name.
 */
/** A `changes` stream from a subscribe/unsubscribe pair (helper event, module emitter). */
export const changesFromSubscription = (
  subscribe: (listener: () => void) => () => void,
): Stream.Stream<void> =>
  Stream.callback<void>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        subscribe(() => {
          Queue.offerUnsafe(queue, undefined);
        }),
      ),
      (unsubscribe) => Effect.sync(() => unsubscribe()),
    ),
  );

export const bridgeMessage = (raw: string): string => {
  const causedBy = raw.lastIndexOf('Caused by:');
  const inner = causedBy === -1 ? raw : raw.slice(causedBy + 'Caused by:'.length);
  return inner.replace(/^\s*RemindersBridgeError:\s*/, '').trim();
};

export interface RemindersClientShape {
  /**
   * Fires whenever EventKit's database changed (any app, any item) — a
   * latency hint for the sync engine, not a correctness mechanism: it
   * reaches a live observer only. Empty where there is no bridge.
   */
  readonly changes: Stream.Stream<void>;
  readonly create: (params: {
    readonly listId: string;
    readonly reminder: ReminderWrite;
  }) => Effect.Effect<ReminderJson, RemindersError>;
  readonly delete: (params: { readonly id: string }) => Effect.Effect<void, RemindersError>;
  readonly listLists: () => Effect.Effect<ReadonlyArray<ReminderListJson>, RemindersError>;
  /** Triggers the OS prompt when undetermined; resolves to the outcome. */
  readonly requestAccess: () => Effect.Effect<boolean, RemindersError>;
  readonly setCompleted: (params: {
    readonly completed: boolean;
    readonly id: string;
  }) => Effect.Effect<ReminderJson, RemindersError>;
  /**
   * Every reminder's (listId, id) plus full rows for those modified since
   * `changedSince` (epoch ms; omit for everything). See SnapshotResult.
   */
  readonly snapshot: (params: {
    readonly changedSince?: number | undefined;
  }) => Effect.Effect<SnapshotResult, RemindersError>;
  readonly status: () => Effect.Effect<RemindersAuthorization, RemindersError>;
  readonly update: (params: {
    readonly changes: ReminderWrite & { readonly listId?: string | undefined };
    readonly id: string;
  }) => Effect.Effect<ReminderJson, RemindersError>;
}

export class RemindersClient extends Context.Service<RemindersClient, RemindersClientShape>()(
  'reminders/RemindersClient',
) {}

/**
 * A transport-agnostic implementation over "send a method + JSON params,
 * get JSON back" — the desktop helper stdio call and the iOS Expo module
 * both fit that shape, so each platform only supplies `invoke`.
 */
export const makeRemindersClient = (
  invoke: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  changes: Stream.Stream<void> = Stream.empty,
): RemindersClientShape => {
  const call = <A, I>(
    method: string,
    result: Schema.Codec<A, I>,
    params?: Record<string, unknown>,
  ): Effect.Effect<A, RemindersError> =>
    Effect.tryPromise({
      catch: (error): RemindersError => {
        const message = bridgeMessage(error instanceof Error ? error.message : String(error));
        // The native sides prefix access failures (see RemindersBridgeError)
        // so they surface as the typed error the sync engine acts on.
        if (message.startsWith('accessDenied: ')) {
          const status = message.slice('accessDenied: '.length);
          return new RemindersAccessError({
            authorization: isAuthorization(status) ? status : 'denied',
          });
        }
        if (message.includes('helper unavailable')) {
          return new RemindersUnavailableError({ message });
        }
        return new RemindersRequestError({ message, method });
      },
      try: () => invoke(method, params),
    }).pipe(
      Effect.flatMap((raw) =>
        Schema.decodeUnknownEffect(result)(raw).pipe(
          Effect.mapError(
            (error) =>
              new RemindersRequestError({ message: `bad response: ${String(error)}`, method }),
          ),
        ),
      ),
    );

  return {
    changes,
    create: ({ listId, reminder }) =>
      Effect.map(
        call(REMINDERS_METHODS.create, ReminderResult, { listId, reminder }),
        (r) => r.reminder,
      ),
    delete: ({ id }) => Effect.asVoid(call(REMINDERS_METHODS.delete, Schema.Unknown, { id })),
    listLists: () => Effect.map(call(REMINDERS_METHODS.listLists, ListListsResult), (r) => r.lists),
    requestAccess: () =>
      Effect.map(call(REMINDERS_METHODS.requestAccess, RequestAccessResult), (r) => r.granted),
    setCompleted: ({ completed, id }) =>
      Effect.map(
        call(REMINDERS_METHODS.setCompleted, ReminderResult, { completed, id }),
        (r) => r.reminder,
      ),
    snapshot: ({ changedSince }) =>
      call(
        REMINDERS_METHODS.snapshot,
        SnapshotResult,
        changedSince === undefined ? {} : { changedSince },
      ),
    status: () => Effect.map(call(REMINDERS_METHODS.status, StatusResult), (r) => r.authorization),
    update: ({ changes, id }) =>
      Effect.map(
        call(REMINDERS_METHODS.update, ReminderResult, { changes, id }),
        (r) => r.reminder,
      ),
  };
};

/**
 * Every method fails with RemindersUnavailableError — the client for
 * builds without a bridge (tests, e2e, a desktop without the helper).
 * `status` reports 'unavailable' instead of failing so UIs can render it.
 */
export const unavailableRemindersClient = (reason: string): RemindersClientShape => {
  const fail = <A>(): Effect.Effect<A, RemindersError> =>
    Effect.fail(new RemindersUnavailableError({ message: reason }));
  return {
    changes: Stream.empty,
    create: () => fail(),
    delete: () => fail(),
    listLists: () => fail(),
    requestAccess: () => fail(),
    setCompleted: () => fail(),
    snapshot: () => fail(),
    status: () => Effect.succeed('unavailable' as const),
    update: () => fail(),
  };
};
