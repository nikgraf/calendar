import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Account, handleBackendInvoke, type BackendHandlers } from '@calendar/core';
import {
  AccountRepo,
  CalendarRepo,
  DATA_KEY,
  EventRepo,
  reposLayer,
  runMigrations,
} from '@calendar/db';
import {
  GoogleCalendarClient,
  GoogleOAuthConfig,
  TokenManager,
  TokenStore,
} from '@calendar/google';
import { commonBackendHandlers, SyncEngine } from '@calendar/sync';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { app, BrowserWindow, ipcMain } from 'electron';
import { Data, Effect, Layer, ManagedRuntime } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { layer as reactivityLayer, Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { runGoogleSignIn } from './auth/loopbackFlow.ts';
import { loadOAuthConfig } from './oauthConfig.ts';
import { safeStorageTokenStore } from './tokens/safeStorageStore.ts';

class OAuthNotConfiguredError extends Data.TaggedError('OAuthNotConfiguredError')<{
  readonly message: string;
}> {}

/**
 * Builds the main-process backend: SQLite + repos + Google client + sync
 * engine, exposed to the renderer over the single 'backend' IPC channel.
 * Data changes are pushed to every window via 'backend:changed'.
 */
export const startBackendHost = (): void => {
  console.log('[backend] starting host');
  const oauth = loadOAuthConfig();

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
    Layer.provideMerge(reactivityLayer),
  );

  const appLayer = SyncEngine.layer.pipe(
    Layer.provideMerge(GoogleCalendarClient.layer),
    Layer.provideMerge(TokenManager.layer),
    Layer.provideMerge(dbLayer),
    Layer.provideMerge(platformLayer),
  );

  const runtime = ManagedRuntime.make(appLayer);

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
    AccountRepo | CalendarRepo | EventRepo | SyncEngine | TokenManager | TokenStore
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

  ipcMain.handle('backend', (_event, method: string, payload: unknown) =>
    runtime.runPromise(handleBackendInvoke(handlers, method, payload)),
  );

  // Push data-change notifications to every window, and start the scheduler.
  runtime
    .runPromise(
      Effect.gen(function* () {
        const reactivity = yield* Reactivity;
        reactivity.registerUnsafe([DATA_KEY], () => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send('backend:changed');
          }
        });
        const engine = yield* SyncEngine;
        yield* engine.start();
        console.log('[backend] runtime ready, scheduler started');
      }),
    )
    .catch((error: unknown) => {
      console.error('[backend] bootstrap failed:', error);
    });
};
