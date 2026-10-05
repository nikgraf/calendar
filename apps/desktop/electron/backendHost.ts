import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AppBackendRpcs, type BackendHandlers, Temporal } from '@calendar/core';
import { forwardingReactivity, makeInvalidationBus, reposLayer, runMigrations } from '@calendar/db';
import {
  GoogleCalendarClient,
  GooglePeopleClient,
  GoogleOAuthConfig,
  GoogleTasksClient,
  TokenManager,
} from '@calendar/google';
import {
  AppleCalendarEvents,
  LocalNotifications,
  commonBackendHandlers,
  type CommonBackendServices,
  DeviceContacts,
  EventMutations,
  finishAddAccount,
  makeAppBackendLayer,
  makeSyncKicker,
  Mirrors,
  PlatformSettings,
  SyncEngine,
  SyncInterval,
} from '@calendar/sync';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { app, powerMonitor } from 'electron';
import { Data, Duration, Effect, Layer, ManagedRuntime } from 'effect';
import { RpcSerialization, RpcServer } from 'effect/rpc';
import { runGoogleSignIn } from './auth/loopbackFlow.ts';
import { loadOAuthConfig } from './oauthConfig.ts';
import { getPrivacyState, setPrivacyChoice } from './privacy.ts';
import { desktopAppleCalendarLayer } from './appleCalendarClient.ts';
import { desktopContactsLayer } from './contactsClient.ts';
import { desktopGeoLayer } from './geoClient.ts';
import { desktopGoogleLayer, seedDesktopGoogleAccounts } from './googleClient.ts';
import { desktopNotificationSink } from './notifications.ts';
import { desktopRemindersLayer } from './remindersClient.ts';
import { rpcServerProtocol } from './rpcProtocol.ts';

class OAuthNotConfiguredError extends Data.TaggedError('OAuthNotConfiguredError')<{
  readonly message: string;
}> {}

/**
 * Hosts the backend in the main process: SQLite + repos + Google client +
 * sync engine, served to renderers as the AppBackend rpc group over the
 * 'rpc' IPC channel — including the typed invalidations stream.
 */
/** Screen privacy lives with the window code (privacy.ts), so the shared export/import reach it through this seam. */
const desktopPlatformSettings: Layer.Layer<PlatformSettings> = Layer.succeed(PlatformSettings, {
  apply: (section) =>
    Effect.sync(() => {
      if (section.screenPrivacy !== undefined) {
        setPrivacyChoice(section.screenPrivacy);
      }
    }),
  read: Effect.sync(() => ({ screenPrivacy: getPrivacyState().mode })),
});

/** What the main process may do with the running backend besides serving rpc. */
export interface BackendHost {
  /** Resolves once the seed, the sync scheduler and the notifications are up. */
  readonly ready: Promise<void>;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, CommonBackendServices | TokenManager>,
  ) => Promise<A>;
  readonly subscribeInvalidations: (listener: (keys: ReadonlyArray<string>) => void) => () => void;
}

export const startBackendHost = (): BackendHost => {
  console.log('[backend] starting host');
  const oauth = loadOAuthConfig();
  const invalidations = makeInvalidationBus();

  // The live e2e suite shortens the poll so a pull lands inside a test's
  // timeout; nothing else sets it.
  const syncIntervalMs = Number(process.env['CALENDAR_SYNC_INTERVAL_MS']);
  const platformLayer = Layer.mergeAll(
    desktopGoogleLayer,
    GoogleOAuthConfig.layer({
      clientId: oauth?.clientId ?? 'unconfigured',
      ...(oauth?.clientSecret ? { clientSecret: oauth.clientSecret } : {}),
    }),
    syncIntervalMs > 0 ? Layer.succeed(SyncInterval, Duration.millis(syncIntervalMs)) : Layer.empty,
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

  // The mirrors sit above the engine: they write under its gate and react to its passes.
  const appLayer = Mirrors.layer.pipe(
    Layer.provideMerge(SyncEngine.layer),
    Layer.provideMerge(EventMutations.layer),
    // Above the Apple read path: the scheduler plans from it.
    Layer.provideMerge(LocalNotifications.layer({ timeZone: () => Temporal.Now.timeZoneId() })),
    Layer.provideMerge(AppleCalendarEvents.layer),
    Layer.provideMerge(desktopAppleCalendarLayer),
    Layer.provideMerge(GoogleCalendarClient.layer),
    Layer.provideMerge(GoogleTasksClient.layer),
    Layer.provideMerge(GooglePeopleClient.layer),
    Layer.provideMerge(desktopRemindersLayer),
    Layer.provideMerge(DeviceContacts.layer),
    Layer.provideMerge(desktopContactsLayer),
    Layer.provideMerge(desktopGeoLayer),
    Layer.provideMerge(TokenManager.layer),
    Layer.provideMerge(dbLayer),
    Layer.provideMerge(platformLayer),
    Layer.provideMerge(desktopNotificationSink),
    Layer.provideMerge(desktopPlatformSettings),
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

  const handlers: BackendHandlers<CommonBackendServices | TokenManager> = {
    ...commonBackendHandlers,

    addAccount: () =>
      Effect.gen(function* () {
        const config = yield* requireOAuth;
        const result = yield* runGoogleSignIn(config.clientId);
        return yield* finishAddAccount(result, randomUUID);
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
  const ready = runtime.runPromise(
    Effect.gen(function* () {
      yield* seedDesktopGoogleAccounts;
      const engine = yield* SyncEngine;
      yield* engine.start();
      yield* (yield* LocalNotifications).start();
      yield* (yield* Mirrors).start();
      console.log('[backend] runtime ready, rpc server + scheduler started');
    }),
  );
  ready.catch((error: unknown) => {
    console.error('[backend] bootstrap failed:', error);
  });

  // The steady-state poll misses the moments staleness is most visible:
  // right after wake, unlock, or refocusing the window. Queued changes
  // backing off go out with it too (syncNow).
  const kickSync = makeSyncKicker(() =>
    runtime.runPromise(Effect.flatMap(SyncEngine, (engine) => engine.syncNow())),
  );
  powerMonitor.on('resume', kickSync);
  powerMonitor.on('unlock-screen', kickSync);
  app.on('browser-window-focus', kickSync);

  return {
    ready,
    run: (effect) => runtime.runPromise(effect),
    subscribeInvalidations: invalidations.subscribe,
  };
};
