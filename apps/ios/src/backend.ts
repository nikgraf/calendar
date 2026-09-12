import {
  makeDirectBackendClient,
  TokenSet,
  type BackendClient,
  type BackendHandlers,
} from '@calendar/core';
import { forwardingReactivity, reposLayer, runMigrations } from '@calendar/db';
import {
  GoogleCalendarClient,
  GooglePeopleClient,
  GoogleOAuthConfig,
  GoogleTasksClient,
  TokenManager,
  TokenStore,
} from '@calendar/google';
import {
  commonBackendHandlers,
  DeviceContacts,
  EventMutations,
  finishAddAccount,
  makeSyncKicker,
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
  Layer.provideMerge(DeviceContacts.layer),
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
      const grant = yield* Effect.tryPromise({
        catch: (error) => new OAuthNotConfiguredError({ message: String(error) }),
        try: () => signInWithGoogle(iosClientId ?? ''),
      });
      const result = yield* tokenManager.exchangeCode(grant);
      return yield* finishAddAccount(result, generateUuid);
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

// Immediate refresh when the app returns to the foreground.
export const kickSync = makeSyncKicker(() =>
  runtime.runPromise(Effect.flatMap(SyncEngine, (engine) => engine.syncAll())),
);
