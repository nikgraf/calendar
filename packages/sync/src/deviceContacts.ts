import { Contact } from '@calendar/core';
import { ContactsClient, contactsReadable } from '@calendar/contacts';
import { Clock, Context, Effect, Layer, Ref, Semaphore, Stream } from 'effect';

/** A snapshot older than this is refetched on the next lookup. */
const STALE_AFTER_MS = 5 * 60 * 1000;
/** After a failed snapshot the previous contacts stay and a retry waits this long. */
const FAILURE_RETRY_MS = 30 * 1000;
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
  // One snapshot at a time: a typeahead burst against a stale cache used
  // to fire one CNContactStore enumeration per keystroke.
  const inFlight = Semaphore.makeUnsafe(1);

  const isStale = (snapshot: Snapshot, now: number): boolean =>
    snapshot.loadedAt === null || now - snapshot.loadedAt > STALE_AFTER_MS;

  const fetchSnapshot = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const authorization = yield* client
      .status()
      .pipe(Effect.orElseSucceed(() => 'unavailable' as const));
    if (!contactsReadable(authorization)) {
      yield* Ref.set(state, { contacts: [], loadedAt: now });
      return;
    }
    const fetched = yield* Effect.result(client.snapshot());
    if (fetched._tag === 'Failure') {
      // Keep what we had and retry soon — a failure used to cache an
      // empty list as if it were fresh, blanking suggestions for 5 min.
      yield* Effect.logWarning('device contacts snapshot failed', {
        error: String(fetched.failure),
      });
      const previous = yield* Ref.get(state);
      yield* Ref.set(state, {
        contacts: previous.contacts,
        loadedAt: now - STALE_AFTER_MS + FAILURE_RETRY_MS,
      });
      return;
    }
    const contacts = fetched.success.map(
      (row) =>
        new Contact({
          displayName: row.displayName,
          email: row.email,
          id: `device:${row.contactId}:${row.email.toLowerCase()}`,
          source: 'device',
        }),
    );
    yield* Ref.set(state, { contacts, loadedAt: now });
  });

  const refresh = (): Effect.Effect<void> => inFlight.withPermits(1)(fetchSnapshot);

  const list = (): Effect.Effect<ReadonlyArray<Contact>> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (isStale(yield* Ref.get(state), now)) {
        // Re-check under the permit: a burst of lookups waits for the one
        // refresh in flight instead of each starting its own.
        yield* inFlight.withPermits(1)(
          Effect.gen(function* () {
            if (isStale(yield* Ref.get(state), yield* Clock.currentTimeMillis)) {
              yield* fetchSnapshot;
            }
          }),
        );
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
