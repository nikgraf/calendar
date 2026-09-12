import { BirthdayRecord, Contact } from '@calendar/core';
import { ContactsClient, contactsReadable, type DeviceBirthdayJson } from '@calendar/contacts';
import { BIRTHDAYS_KEY } from '@calendar/db/keys';
import { Clock, Context, Effect, Layer, Ref, Semaphore, Stream } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';

/** A snapshot older than this is refetched on the next lookup. */
const STALE_AFTER_MS = 5 * 60 * 1000;
/** After a failed snapshot the previous contacts stay and a retry waits this long. */
const FAILURE_RETRY_MS = 30 * 1000;
/** CNContactStoreDidChange arrives in bursts (iCloud sync). */
const CHANGE_DEBOUNCE = '2 seconds';

export interface DeviceContactsShape {
  /** Birthdays from the same snapshot (empty without access); refreshes when stale. */
  readonly birthdays: () => Effect.Effect<ReadonlyArray<BirthdayRecord>>;
  /** The cached address book (empty without access); refreshes when stale. */
  readonly list: () => Effect.Effect<ReadonlyArray<Contact>>;
  /** Refetches now — after a grant, or a change notification. Never fails. */
  readonly refresh: () => Effect.Effect<void>;
}

interface Snapshot {
  readonly birthdays: ReadonlyArray<BirthdayRecord>;
  readonly contacts: ReadonlyArray<Contact>;
  readonly loadedAt: number | null;
}

const EMPTY: Snapshot = { birthdays: [], contacts: [], loadedAt: null };

const birthdayRecord = (row: DeviceBirthdayJson): BirthdayRecord | undefined => {
  const displayName = row.displayName?.trim();
  if (!displayName) {
    return undefined;
  }
  const id = `device:${row.contactId}`;
  return new BirthdayRecord({
    day: row.day,
    displayName,
    id,
    month: row.month,
    sources: [{ id, source: 'device' }],
    year: row.year,
  });
};

/** Stable digest of a birthday list, so a refresh that changed nothing invalidates nothing. */
const digest = (birthdays: ReadonlyArray<BirthdayRecord>): string =>
  birthdays
    .map(
      (record) =>
        `${record.id}:${String(record.month)}-${String(record.day)}:${String(record.year)}`,
    )
    .sort()
    .join('|');

/**
 * The device address book, held in memory for the invitee typeahead and
 * the birthday lane — never written to SQLite. Loaded lazily on first
 * lookup, refreshed on change notifications and when stale (which also
 * picks up a grant made in System Settings without pressing anything in
 * the app). No access or no bridge simply means no device suggestions.
 */
const make: Effect.Effect<DeviceContactsShape, never, ContactsClient | Reactivity> = Effect.gen(
  function* () {
    const client = yield* ContactsClient;
    const reactivity = yield* Reactivity;
    const state = yield* Ref.make<Snapshot>(EMPTY);
    // One snapshot at a time: a typeahead burst against a stale cache used
    // to fire one CNContactStore enumeration per keystroke.
    const inFlight = Semaphore.makeUnsafe(1);

    const isStale = (snapshot: Snapshot, now: number): boolean =>
      snapshot.loadedAt === null || now - snapshot.loadedAt > STALE_AFTER_MS;

    const setSnapshot = (next: Snapshot) =>
      Effect.gen(function* () {
        const previous = yield* Ref.get(state);
        yield* Ref.set(state, next);
        if (digest(previous.birthdays) !== digest(next.birthdays)) {
          yield* reactivity.invalidate([BIRTHDAYS_KEY]);
        }
      });

    const fetchSnapshot = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const authorization = yield* client
        .status()
        .pipe(Effect.orElseSucceed(() => 'unavailable' as const));
      if (!contactsReadable(authorization)) {
        yield* setSnapshot({ birthdays: [], contacts: [], loadedAt: now });
        return;
      }
      const fetched = yield* Effect.result(client.snapshot());
      const previous = yield* Ref.get(state);
      if (fetched._tag === 'Failure') {
        // Keep what we had and retry soon — a failure used to cache an
        // empty list as if it were fresh, blanking suggestions for 5 min.
        yield* Effect.logWarning('device contacts snapshot failed', {
          error: String(fetched.failure),
        });
        yield* Ref.set(state, {
          ...previous,
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
      // A bridge built before `contacts.birthdays` existed rejects the
      // method: keep the previous birthdays rather than fail the snapshot
      // the typeahead needs.
      const birthdays = yield* client.birthdays().pipe(
        Effect.map((rows) => rows.flatMap((row) => birthdayRecord(row) ?? [])),
        Effect.orElseSucceed(() => previous.birthdays),
      );
      yield* setSnapshot({ birthdays, contacts, loadedAt: now });
    });

    const refresh = (): Effect.Effect<void> => inFlight.withPermits(1)(fetchSnapshot);

    const ensureFresh = (): Effect.Effect<Snapshot> =>
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
        return yield* Ref.get(state);
      });

    yield* Effect.forkDetach(
      client.changes.pipe(
        Stream.debounce(CHANGE_DEBOUNCE),
        Stream.runForEach(() => refresh()),
      ),
    );

    return {
      birthdays: () => Effect.map(ensureFresh(), (snapshot) => snapshot.birthdays),
      list: () => Effect.map(ensureFresh(), (snapshot) => snapshot.contacts),
      refresh,
    };
  },
);

export class DeviceContacts extends Context.Service<DeviceContacts, DeviceContactsShape>()(
  'sync/DeviceContacts',
) {
  static readonly layer: Layer.Layer<DeviceContacts, never, ContactsClient | Reactivity> =
    Layer.effect(DeviceContacts)(make);
}
