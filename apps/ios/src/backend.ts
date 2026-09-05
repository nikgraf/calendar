import {
  Account,
  makeDirectBackendClient,
  TokenSet,
  type BackendClient,
  type BackendHandlers,
} from '@calendar/core';
import { AccountRepo, forwardingReactivity, reposLayer, runMigrations } from '@calendar/db';
import {
  GoogleCalendarClient,
  GooglePeopleClient,
  GoogleOAuthConfig,
  GoogleTasksClient,
  grantsContacts,
  TASKS_SCOPE,
  TokenManager,
  TokenStore,
} from '@calendar/google';
import {
  commonBackendHandlers,
  EventMutations,
  SyncEngine,
  type CommonBackendServices,
} from '@calendar/sync';
import { layer as sqliteLayer } from '@effect/sql-sqlite-react-native/SqliteClient';
import Constants from 'expo-constants';
import { deleteItemAsync, getItemAsync, setItemAsync } from 'expo-secure-store';
import { Data, Effect, Layer, ManagedRuntime, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { signInWithGoogle } from './googleAuth.ts';
import { iosContactsLayer } from './contactsClient.ts';
import { iosRemindersLayer } from './remindersClient.ts';

class OAuthNotConfiguredError extends Data.TaggedError('OAuthNotConfiguredError')<{
  readonly message: string;
}> {}

export const iosClientId: string | undefined = (
  Constants.expoConfig?.extra as { googleIosClientId?: string } | undefined
)?.googleIosClientId;

/** iOS Keychain-backed TokenStore (expo-secure-store). */
const secureTokenStore: Layer.Layer<TokenStore> = Layer.succeed(TokenStore, {
  get: (accountId) =>
    Effect.promise(async () => {
      const raw = await getItemAsync(`tokens.${accountId}`);
      if (!raw) {
        return null;
      }
      try {
        return Schema.decodeUnknownSync(TokenSet)(JSON.parse(raw));
      } catch {
        return null;
      }
    }),
  remove: (accountId) => Effect.promise(() => deleteItemAsync(`tokens.${accountId}`)),
  set: (accountId, tokens) =>
    Effect.promise(() =>
      setItemAsync(`tokens.${accountId}`, JSON.stringify(Schema.encodeSync(TokenSet)(tokens))),
    ),
});

const invalidationListeners = new Set<(keys: ReadonlyArray<unknown>) => void>();

/** Streams backend invalidation keys to the UI atom runtime (in-process). */
export const subscribeInvalidations = (
  listener: (keys: ReadonlyArray<unknown>) => void,
): (() => void) => {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
};

const dbLayer = reposLayer.pipe(
  Layer.provideMerge(Layer.effectDiscard(runMigrations)),
  Layer.provideMerge(sqliteLayer({ filename: 'calendar.db' })),
  Layer.provideMerge(
    forwardingReactivity((keys) => {
      for (const listener of invalidationListeners) {
        listener(keys);
      }
    }),
  ),
);

const platformLayer = Layer.mergeAll(
  secureTokenStore,
  FetchHttpClient.layer,
  GoogleOAuthConfig.layer({ clientId: iosClientId ?? 'unconfigured' }),
);

const appLayer = SyncEngine.layer.pipe(
  Layer.provideMerge(EventMutations.layer),
  Layer.provideMerge(GoogleCalendarClient.layer),
  Layer.provideMerge(GoogleTasksClient.layer),
  Layer.provideMerge(GooglePeopleClient.layer),
  Layer.provideMerge(iosRemindersLayer),
  Layer.provideMerge(iosContactsLayer),
  Layer.provideMerge(TokenManager.layer),
  Layer.provideMerge(dbLayer),
  Layer.provideMerge(platformLayer),
);

const runtime = ManagedRuntime.make(appLayer);

const generateUuid = (): string =>
  // eslint-disable-next-line unicorn/prefer-crypto-uuid -- Hermes lacks crypto.randomUUID
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replaceAll(/[xy]/g, (char) => {
    const random = Math.trunc(Math.random() * 16);
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });

const handlers: BackendHandlers<CommonBackendServices | TokenManager> = {
  ...commonBackendHandlers,

  addAccount: () =>
    Effect.gen(function* () {
      if (!iosClientId) {
        return yield* Effect.fail(
          new OAuthNotConfiguredError({
            message:
              'Google OAuth is not configured. Set expo.extra.googleIosClientId ' +
              'in apps/ios/app.json (iOS OAuth client id) and rebuild.',
          }),
        );
      }
      const tokenManager = yield* TokenManager;
      const accountRepo = yield* AccountRepo;
      const tokenStore = yield* TokenStore;
      const engine = yield* SyncEngine;

      const grant = yield* Effect.tryPromise({
        catch: (error) => new OAuthNotConfiguredError({ message: String(error) }),
        try: () => signInWithGoogle(iosClientId ?? ''),
      });
      const result = yield* tokenManager.exchangeCode(grant);

      const existing = (yield* accountRepo.list()).find(
        (candidate) => candidate.email === result.profile.email,
      );
      const account = new Account({
        avatarUrl: result.profile.avatarUrl,
        contactsEnabled: grantsContacts(result.tokens.scopes),
        createdAt: Date.now(),
        displayName: result.profile.displayName,
        email: result.profile.email,
        id: existing?.id ?? generateUuid(),
        provider: 'google',
        status: 'ok',
        // What Google actually granted, not what we asked for — a user
        // can untick scopes on the consent screen.
        tasksEnabled: result.tokens.scopes.includes(TASKS_SCOPE),
      });
      yield* tokenStore.set(account.id, result.tokens);
      yield* accountRepo.upsert(account);
      yield* Effect.forkDetach(engine.syncAll());
      return account;
    }),
};

export const backendClient: BackendClient = makeDirectBackendClient(handlers, (effect) =>
  runtime.runPromise(effect),
);

export const startSync = (): void => {
  runtime
    .runPromise(
      Effect.gen(function* () {
        const engine = yield* SyncEngine;
        yield* engine.start();
      }),
    )
    .catch(() => {
      // Same reasoning as kickSync: a failed start must not surface as an
      // unhandled rejection; the engine logs its own failures.
    });
};

// Immediate refresh when the app returns to the foreground; syncAll is
// semaphore-serialized so overlapping kicks are safe.
let lastKickAt = 0;
export const kickSync = (): void => {
  const now = Date.now();
  if (now - lastKickAt < 15_000) {
    return;
  }
  lastKickAt = now;
  runtime
    .runPromise(
      Effect.gen(function* () {
        const engine = yield* SyncEngine;
        yield* engine.syncAll();
      }),
    )
    .catch(() => {
      // Transient failures are retried by the regular schedule.
    });
};
