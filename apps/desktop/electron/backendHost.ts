import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Account, AppBackendRpcs, type BackendHandlers } from '@calendar/core';
import {
  AccountRepo,
  CalendarRepo,
  EventRepo,
  forwardingReactivity,
  makeInvalidationBus,
  PendingOpRepo,
  reposLayer,
  runMigrations,
} from '@calendar/db';
import {
  GoogleCalendarClient,
  GoogleOAuthConfig,
  TokenManager,
  TokenStore,
} from '@calendar/google';
import {
  commonBackendHandlers,
  EventMutations,
  makeAppBackendLayer,
  SyncEngine,
} from '@calendar/sync';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { app } from 'electron';
import { Data, Effect, Layer, ManagedRuntime } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc';
import { runGoogleSignIn } from './auth/loopbackFlow.ts';
import { loadOAuthConfig } from './oauthConfig.ts';
import { rpcServerProtocol } from './rpcProtocol.ts';
import { safeStorageTokenStore } from './tokens/safeStorageStore.ts';

class OAuthNotConfiguredError extends Data.TaggedError('OAuthNotConfiguredError')<{
  readonly message: string;
}> {}

/**
 * Hosts the backend in the main process: SQLite + repos + Google client +
 * sync engine, served to renderers as the AppBackend rpc group over the
 * 'rpc' IPC channel — including the typed invalidations stream.
 */
export const startBackendHost = (): void => {
  console.log('[backend] starting host');
  const oauth = loadOAuthConfig();
  const invalidations = makeInvalidationBus();

  const platformLayer = Layer.mergeAll(
    safeStorageTokenStore,
    FetchHttpClient.layer,
    GoogleOAuthConfig.layer({
      clientId: oauth?.clientId ?? 'unconfigured',
      ...(oauth?.clientSecret ? { clientSecret: oauth.clientSecret } : {}),
    }),
  );

  const dbLayer = reposLayer.pipe(
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(
      SqliteClient.layer({
        filename: join(app.getPath('userData'), 'calendar.db'),
      }),
    ),
    Layer.provideMerge(forwardingReactivity(invalidations.publish)),
  );

  const appLayer = SyncEngine.layer.pipe(
    Layer.provideMerge(EventMutations.layer),
    Layer.provideMerge(GoogleCalendarClient.layer),
    Layer.provideMerge(TokenManager.layer),
    Layer.provideMerge(dbLayer),
    Layer.provideMerge(platformLayer),
  );

  const requireOAuth = Effect.suspend(() =>
    oauth
      ? Effect.succeed(oauth)
      : Effect.fail(
          new OAuthNotConfiguredError({
            message:
              'Google OAuth is not configured. Set GOOGLE_DESKTOP_CLIENT_ID ' +
              '(and optionally GOOGLE_DESKTOP_CLIENT_SECRET), or create ' +
              'apps/desktop/google-oauth.local.json with {"clientId": "..."}.',
          }),
        ),
  );

  const handlers: BackendHandlers<
    | AccountRepo
    | CalendarRepo
    | EventMutations
    | EventRepo
    | PendingOpRepo
    | SyncEngine
    | TokenManager
    | TokenStore
  > = {
    ...commonBackendHandlers,

    addAccount: () =>
      Effect.gen(function* () {
        const config = yield* requireOAuth;
        const accountRepo = yield* AccountRepo;
        const tokenStore = yield* TokenStore;
        const engine = yield* SyncEngine;

        const result = yield* runGoogleSignIn(config.clientId);
        const existing = (yield* accountRepo.list()).find(
          (candidate) => candidate.email === result.profile.email,
        );
        const account = new Account({
          avatarUrl: result.profile.avatarUrl,
          createdAt: Date.now(),
          displayName: result.profile.displayName,
          email: result.profile.email,
          id: existing?.id ?? randomUUID(),
          status: 'ok',
        });
        yield* tokenStore.set(account.id, result.tokens);
        yield* accountRepo.upsert(account);
        // Populate calendars/events in the background.
        yield* Effect.forkDetach(engine.syncAll());
        return account;
      }),
  };

  const rpcLayer = RpcServer.layer(AppBackendRpcs, {
    disableFatalDefects: true,
  }).pipe(
    Layer.provide(
      makeAppBackendLayer({
        handlers,
        subscribeInvalidations: invalidations.subscribe,
      }),
    ),
    Layer.provide(rpcServerProtocol),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(appLayer),
  );

  const runtime = ManagedRuntime.make(Layer.provideMerge(rpcLayer, appLayer));

  // Building the runtime starts the rpc server; then start the scheduler.
  runtime
    .runPromise(
      Effect.gen(function* () {
        const engine = yield* SyncEngine;
        yield* engine.start();
        console.log('[backend] runtime ready, rpc server + scheduler started');
      }),
    )
    .catch((error: unknown) => {
      console.error('[backend] bootstrap failed:', error);
    });
};
