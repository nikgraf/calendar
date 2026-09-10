import { Contact } from '@calendar/core';
import { ContactsClient, contactsReadable } from '@calendar/contacts';
import { Clock, Context, Effect, Layer, Ref, Stream } from 'effect';

/** A snapshot older than this is refetched on the next lookup. */
const STALE_AFTER_MS = 5 * 60 * 1000;
/** CNContactStoreDidChange arrives in bursts (iCloud sync). */
const CHANGE_DEBOUNCE = '2 seconds';

export interface DeviceContactsShape {
  /** The cached address book (empty without access); refreshes when stale. */
  readonly list: () => Effect.Effect<ReadonlyArray<Contact>>;
  /** Refetches now — after a grant, or a change notification. Never fails. */
  readonly refresh: () => Effect.Effect<void>;
}

interface Snapshot {
  readonly contacts: ReadonlyArray<Contact>;
  readonly loadedAt: number | null;
}

/**
 * The device address book, held in memory for the invitee typeahead —
 * never written to SQLite. Loaded lazily on first lookup, refreshed on
 * change notifications and when stale (which also picks up a grant made
 * in System Settings without pressing anything in the app). No access
 * or no bridge simply means no device suggestions.
 */
const make: Effect.Effect<DeviceContactsShape, never, ContactsClient> = Effect.gen(function* () {
  const client = yield* ContactsClient;
  const state = yield* Ref.make<Snapshot>({ contacts: [], loadedAt: null });

  const refresh = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const authorization = yield* client
        .status()
        .pipe(Effect.orElseSucceed(() => 'unavailable' as const));
      const contacts = contactsReadable(authorization)
        ? yield* client.snapshot().pipe(
            Effect.map((rows) =>
              rows.map(
                (row) =>
                  new Contact({
                    displayName: row.displayName,
                    email: row.email,
                    id: `device:${row.contactId}:${row.email.toLowerCase()}`,
                    source: 'device',
                  }),
              ),
            ),
            Effect.tapError((error) =>
              Effect.logWarning('device contacts snapshot failed', { error: String(error) }),
            ),
            Effect.orElseSucceed((): ReadonlyArray<Contact> => []),
          )
        : [];
      yield* Ref.set(state, { contacts, loadedAt: now });
    });

  const list = (): Effect.Effect<ReadonlyArray<Contact>> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const current = yield* Ref.get(state);
      if (current.loadedAt === null || now - current.loadedAt > STALE_AFTER_MS) {
        yield* refresh();
      }
      return (yield* Ref.get(state)).contacts;
    });

  yield* Effect.forkDetach(
    client.changes.pipe(
      Stream.debounce(CHANGE_DEBOUNCE),
      Stream.runForEach(() => refresh()),
    ),
  );

  return { list, refresh };
});

export class DeviceContacts extends Context.Service<DeviceContacts, DeviceContactsShape>()(
  'sync/DeviceContacts',
) {
  static readonly layer: Layer.Layer<DeviceContacts, never, ContactsClient> =
    Layer.effect(DeviceContacts)(make);
}
