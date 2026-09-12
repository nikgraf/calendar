import { Effect, Queue, Stream } from 'effect';

/**
 * Helpers shared by the native bridge clients (Reminders, Contacts) on
 * both hosts: the desktop Swift helper over stdio and the iOS Expo
 * modules. They used to live in @calendar/reminders, which made
 * @calendar/contacts depend on it for nothing else.
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

/**
 * The bridge's own message, whatever the transport wrapped around it. The
 * helper emits it verbatim; expo-modules-core rethrows it as
 * "FunctionCallException: … → Caused by: RemindersBridgeError: <message>",
 * so take the last "Caused by:" segment and strip the exception name.
 */
export const bridgeMessage = (raw: string): string => {
  const causedBy = raw.lastIndexOf('Caused by:');
  const inner = causedBy === -1 ? raw : raw.slice(causedBy + 'Caused by:'.length);
  return inner.replace(/^\s*\w*BridgeError:\s*/, '').trim();
};

/**
 * What a platform supplies to stand up a bridge client: one request
 * function and one event subscription. The desktop helper and the iOS
 * Expo modules both fit this shape.
 */
export interface BridgeTransport {
  readonly invoke: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  readonly subscribe: (event: string, listener: () => void) => () => void;
}
