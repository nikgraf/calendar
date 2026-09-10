import { bridgeMessage } from '@calendar/reminders/client';
import { Context, Data, Effect, Schema, Stream } from 'effect';
import {
  CONTACTS_METHODS,
  type ContactsAuthorization,
  type DeviceContactJson,
  RequestAccessResult,
  SnapshotResult,
  StatusResult,
} from './protocol.ts';

/** Contacts access is missing (denied/restricted/not asked yet). */
export class ContactsAccessError extends Data.TaggedError('ContactsAccessError')<{
  readonly authorization: ContactsAuthorization;
}> {}

/** No native Contacts bridge on this build/platform (helper missing, module absent). */
export class ContactsUnavailableError extends Data.TaggedError('ContactsUnavailableError')<{
  readonly message: string;
}> {}

/** The bridge answered with an error (fetch failure, bad response, …). */
export class ContactsRequestError extends Data.TaggedError('ContactsRequestError')<{
  readonly message: string;
  readonly method: string;
}> {}

export type ContactsError = ContactsAccessError | ContactsRequestError | ContactsUnavailableError;

const AUTHORIZATIONS: ReadonlySet<string> = new Set([
  'authorized',
  'denied',
  'limited',
  'notDetermined',
  'restricted',
  'unavailable',
]);
const isAuthorization = (value: string): value is ContactsAuthorization =>
  AUTHORIZATIONS.has(value);

/** Access levels under which the address book can be read. */
export const contactsReadable = (authorization: ContactsAuthorization): boolean =>
  authorization === 'authorized' || authorization === 'limited';

export interface ContactsClientShape {
  /**
   * Fires whenever the device address book changed (any app) — a hint
   * to refetch the snapshot, not a correctness mechanism. Empty where
   * there is no bridge.
   */
  readonly changes: Stream.Stream<void>;
  /** Triggers the OS prompt when undetermined; resolves to the outcome. */
  readonly requestAccess: () => Effect.Effect<boolean, ContactsError>;
  /** Every contact with an email, one row per address. */
  readonly snapshot: () => Effect.Effect<ReadonlyArray<DeviceContactJson>, ContactsError>;
  readonly status: () => Effect.Effect<ContactsAuthorization, ContactsError>;
}

export class ContactsClient extends Context.Service<ContactsClient, ContactsClientShape>()(
  'contacts/ContactsClient',
) {}

/**
 * A transport-agnostic implementation over "send a method + JSON params,
 * get JSON back" — the desktop helper stdio call and the iOS Expo module
 * both fit that shape, so each platform only supplies `invoke`.
 */
export const makeContactsClient = (
  invoke: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  changes: Stream.Stream<void> = Stream.empty,
): ContactsClientShape => {
  const call = <A, I>(
    method: string,
    result: Schema.Codec<A, I>,
  ): Effect.Effect<A, ContactsError> =>
    Effect.tryPromise({
      catch: (error): ContactsError => {
        const message = bridgeMessage(error instanceof Error ? error.message : String(error));
        // The native sides prefix access failures (see ContactsBridgeError)
        // so they surface as the typed error callers act on.
        if (message.startsWith('accessDenied: ')) {
          const status = message.slice('accessDenied: '.length);
          return new ContactsAccessError({
            authorization: isAuthorization(status) ? status : 'denied',
          });
        }
        if (message.includes('helper unavailable')) {
          return new ContactsUnavailableError({ message });
        }
        return new ContactsRequestError({ message, method });
      },
      try: () => invoke(method),
    }).pipe(
      Effect.flatMap((raw) =>
        Schema.decodeUnknownEffect(result)(raw).pipe(
          Effect.mapError(
            (error) =>
              new ContactsRequestError({ message: `bad response: ${String(error)}`, method }),
          ),
        ),
      ),
    );

  return {
    changes,
    requestAccess: () =>
      Effect.map(call(CONTACTS_METHODS.requestAccess, RequestAccessResult), (r) => r.granted),
    snapshot: () => Effect.map(call(CONTACTS_METHODS.snapshot, SnapshotResult), (r) => r.contacts),
    status: () => Effect.map(call(CONTACTS_METHODS.status, StatusResult), (r) => r.authorization),
  };
};

/**
 * Every method fails with ContactsUnavailableError — the client for
 * builds without a bridge (tests, e2e, a desktop without the helper).
 * `status` reports 'unavailable' instead of failing so UIs can render it.
 */
export const unavailableContactsClient = (reason: string): ContactsClientShape => {
  const fail = <A>(): Effect.Effect<A, ContactsError> =>
    Effect.fail(new ContactsUnavailableError({ message: reason }));
  return {
    changes: Stream.empty,
    requestAccess: () => fail(),
    snapshot: () => fail(),
    status: () => Effect.succeed('unavailable' as const),
  };
};
