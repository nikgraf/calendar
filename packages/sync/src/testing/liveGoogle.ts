import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unavailableAppleCalendarClient } from '@calendar/apple-calendar';
import { Account, TokenSet } from '@calendar/core';
import { AccountRepo, reposLayer, runMigrations } from '@calendar/db';
import {
  GOOGLE_SCOPES,
  GoogleCalendarClient,
  GoogleOAuthConfig,
  GooglePeopleClient,
  GoogleTasksClient,
  GuestNotifications,
  type ReauthRequiredError,
  TokenManager,
  type TokenRefreshError,
  TokenStore,
} from '@calendar/google';
import { RemindersClient, unavailableRemindersClient } from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { Context, Data, Effect, Layer, ManagedRuntime } from 'effect';
import { FetchHttpClient, type HttpClient } from 'effect/unstable/http';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { appleCalendarServicesLayer } from '../appleCalendarEvents.ts';
import { SyncEngine } from '../engine.ts';
import { EventMutations } from '../mutations.ts';
import {
  createCalendar,
  createTaskList,
  deleteCalendar,
  deleteEvent,
  deleteTask,
  deleteTaskList,
  findEvents,
  getCalendarListEntry,
  getEvent,
  getTask,
  insertEvent,
  insertTask,
  LIVE_CALENDAR_SCOPE,
  listTasks,
  type LiveCalendarListEntry,
  type LiveEvent,
  type LiveTask,
  patchEvent,
  patchTask,
  scratchName as scratchNameFor,
  sweep,
} from './liveScratchRest.ts';

export {
  LIVE_CALENDAR_SCOPE,
  type LiveCalendarListEntry,
  type LiveEvent,
  type LiveTask,
  parseScratchName,
} from './liveScratchRest.ts';

/**
 * The live Google suites: the real clients, request core, engine and
 * mutations over the real wire against a dedicated throwaway account.
 * `googleFixture.ts` is the same recipe with the fake in place of fetch;
 * here only the token store is pre-filled — with a refresh token, so the
 * first request goes through the TokenManager's refresh like a real
 * sign-in that aged.
 *
 * Config comes from the environment (CI secrets) or, locally, the
 * gitignored `google-live.local.json` written by
 * `scripts/google-live-token.mjs`. See docs/google-sync-and-testing.md.
 */

/** The seeded account row; the token store holds the refresh token under it. */
export const LIVE_ACCOUNT_ID = 'acc-live';

export interface LiveGoogleConfig {
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  readonly email: string;
  /** IANA-reserved domain: never delivered, never folded into the organizer. */
  readonly guestEmail: string;
  readonly refreshToken: string;
  /** Distinguishes this run's scratch resources: `gh-<run>-<attempt>` or `local-<pid>`. */
  readonly runTag: string;
}

/** What the desktop and iOS hosts read to sign the live account in (JSON on desktop, env on iOS). */
export interface LiveAccountSeed {
  readonly contactsEnabled: boolean;
  readonly email: string;
  readonly refreshToken: string;
  readonly tasksEnabled: boolean;
}

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const readJson = (path: string): Record<string, string> | undefined =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>) : undefined;

const SETUP_HINT =
  'the live Google suite needs GOOGLE_LIVE_REFRESH_TOKEN, GOOGLE_LIVE_EMAIL and ' +
  'GOOGLE_DESKTOP_CLIENT_ID (or google-live.local.json + apps/desktop/google-oauth.local.json): ' +
  'run `node scripts/google-live-token.mjs --write` once — see docs/google-sync-and-testing.md';

/**
 * Environment first, then the two gitignored local files. Throws with the
 * setup hint when anything is missing: a live file that silently skipped
 * would report green while testing nothing.
 */
export const liveGoogleConfigFromEnv = (): LiveGoogleConfig => {
  const live = readJson(join(REPO_ROOT, 'google-live.local.json'));
  const oauth = readJson(join(REPO_ROOT, 'apps/desktop/google-oauth.local.json'));
  const refreshToken = process.env['GOOGLE_LIVE_REFRESH_TOKEN'] || live?.['refreshToken'];
  const email = process.env['GOOGLE_LIVE_EMAIL'] || live?.['email'];
  const clientId = process.env['GOOGLE_DESKTOP_CLIENT_ID'] || oauth?.['clientId'];
  const clientSecret = process.env['GOOGLE_DESKTOP_CLIENT_SECRET'] || oauth?.['clientSecret'];
  if (!refreshToken || !email || !clientId) {
    throw new Error(SETUP_HINT);
  }
  const runTag = process.env['GOOGLE_LIVE_RUN_TAG'] || `local-${process.pid}`;
  return {
    clientId,
    clientSecret: clientSecret || undefined,
    email,
    guestEmail: `guest-${runTag}@example.com`,
    refreshToken,
    runTag,
  };
};

/** One store per refresh token: every layer built from a config shares the refreshed access token. */
const stores = new Map<string, Layer.Layer<TokenStore>>();

/**
 * The real wire plus a memory token store that already holds the live
 * account's refresh token. `expiresAt: 0` makes the first request refresh.
 */
export const liveWireLayer = (
  seed: Pick<LiveGoogleConfig, 'refreshToken'>,
  accountId = LIVE_ACCOUNT_ID,
): Layer.Layer<HttpClient.HttpClient | TokenStore> => {
  let store = stores.get(`${accountId}:${seed.refreshToken}`);
  if (!store) {
    store = TokenStore.layerMemoryWith([
      [
        accountId,
        new TokenSet({
          accessToken: '',
          expiresAt: 0,
          refreshToken: seed.refreshToken,
          scopes: [...GOOGLE_SCOPES, LIVE_CALENDAR_SCOPE],
        }),
      ],
    ]);
    stores.set(`${accountId}:${seed.refreshToken}`, store);
  }
  return Layer.mergeAll(FetchHttpClient.layer, store);
};

/** The wire, the OAuth client and a TokenManager, with guest mail muted. */
export const liveGoogleLayer = (
  config: LiveGoogleConfig,
): Layer.Layer<GoogleOAuthConfig | HttpClient.HttpClient | TokenManager | TokenStore> =>
  Layer.mergeAll(TokenManager.layer, Layer.succeed(GuestNotifications, 'none')).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        liveWireLayer(config),
        GoogleOAuthConfig.layer({
          clientId: config.clientId,
          ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
        }),
      ),
    ),
  );

/** Upserts the live account row (idempotent), like `seedFixtureAccounts`. */
export const seedLiveAccount = (
  seed: Pick<LiveAccountSeed, 'email'> & Partial<LiveAccountSeed>,
  accountId = LIVE_ACCOUNT_ID,
): Effect.Effect<void, SqlError, AccountRepo> =>
  Effect.gen(function* () {
    const accounts = yield* AccountRepo;
    const existing = yield* accounts.get(accountId);
    yield* accounts.upsert(
      new Account({
        contactsEnabled: seed.contactsEnabled ?? false,
        createdAt: existing?.createdAt ?? Date.now(),
        email: seed.email,
        id: accountId,
        provider: 'google',
        status: 'ok',
        tasksEnabled: seed.tasksEnabled ?? true,
      }),
    );
  });

export const scratchName = (config: Pick<LiveGoogleConfig, 'runTag'>, suffix?: string): string =>
  scratchNameFor(config.runTag, suffix);

export class LiveGoogleError extends Data.TaggedError('LiveGoogleError')<{
  readonly cause: unknown;
  readonly message: string;
}> {}

type ScratchError = LiveGoogleError | ReauthRequiredError | TokenRefreshError;

/**
 * The admin side of a live test (`liveScratchRest.ts`) as an Effect
 * service over the app's own TokenManager: scratch calendars and lists,
 * and the edits "another device" makes behind the app's back.
 */
export interface LiveScratchShape {
  readonly createCalendar: (
    summary: string,
  ) => Effect.Effect<{ readonly id: string }, ScratchError>;
  readonly createTaskList: (title: string) => Effect.Effect<{ readonly id: string }, ScratchError>;
  readonly deleteCalendar: (calendarId: string) => Effect.Effect<void, ScratchError>;
  readonly deleteEvent: (calendarId: string, eventId: string) => Effect.Effect<void, ScratchError>;
  readonly deleteTask: (listId: string, taskId: string) => Effect.Effect<void, ScratchError>;
  readonly deleteTaskList: (listId: string) => Effect.Effect<void, ScratchError>;
  readonly findEvents: (
    calendarId: string,
    q: string,
  ) => Effect.Effect<ReadonlyArray<LiveEvent>, ScratchError>;
  readonly getCalendarListEntry: (
    calendarId: string,
  ) => Effect.Effect<LiveCalendarListEntry, ScratchError>;
  readonly getEvent: (
    calendarId: string,
    eventId: string,
  ) => Effect.Effect<LiveEvent, ScratchError>;
  readonly getTask: (listId: string, taskId: string) => Effect.Effect<LiveTask, ScratchError>;
  readonly insertEvent: (
    calendarId: string,
    event: Record<string, unknown>,
  ) => Effect.Effect<LiveEvent, ScratchError>;
  readonly insertTask: (
    listId: string,
    task: Record<string, unknown>,
  ) => Effect.Effect<LiveTask, ScratchError>;
  readonly listTasks: (listId: string) => Effect.Effect<ReadonlyArray<LiveTask>, ScratchError>;
  readonly patchEvent: (
    calendarId: string,
    eventId: string,
    changes: Record<string, unknown>,
  ) => Effect.Effect<LiveEvent, ScratchError>;
  readonly patchTask: (
    listId: string,
    taskId: string,
    changes: Record<string, unknown>,
  ) => Effect.Effect<LiveTask, ScratchError>;
  /** Removes scratch calendars/lists older than `maxAgeMs` (a crashed run's leftovers). */
  readonly sweep: (options: {
    readonly maxAgeMs: number;
  }) => Effect.Effect<{ readonly calendars: number; readonly lists: number }, ScratchError>;
}

const makeLiveScratch = (accountId: string): Effect.Effect<LiveScratchShape, never, TokenManager> =>
  Effect.gen(function* () {
    const tokenManager = yield* TokenManager;
    const call = <A>(run: (token: string) => Promise<A>): Effect.Effect<A, ScratchError> =>
      Effect.gen(function* () {
        const token = yield* tokenManager.getAccessToken(accountId);
        return yield* Effect.tryPromise({
          catch: (cause) =>
            new LiveGoogleError({
              cause,
              message: cause instanceof Error ? cause.message : String(cause),
            }),
          try: () => run(token),
        });
      });
    return {
      createCalendar: (summary) => call((token) => createCalendar(token, summary)),
      createTaskList: (title) => call((token) => createTaskList(token, title)),
      deleteCalendar: (calendarId) => call((token) => deleteCalendar(token, calendarId)),
      deleteEvent: (calendarId, eventId) =>
        call((token) => deleteEvent(token, calendarId, eventId)),
      deleteTask: (listId, taskId) => call((token) => deleteTask(token, listId, taskId)),
      deleteTaskList: (listId) => call((token) => deleteTaskList(token, listId)),
      findEvents: (calendarId, q) => call((token) => findEvents(token, calendarId, q)),
      getCalendarListEntry: (calendarId) =>
        call((token) => getCalendarListEntry(token, calendarId)),
      getEvent: (calendarId, eventId) => call((token) => getEvent(token, calendarId, eventId)),
      getTask: (listId, taskId) => call((token) => getTask(token, listId, taskId)),
      insertEvent: (calendarId, event) => call((token) => insertEvent(token, calendarId, event)),
      insertTask: (listId, task) => call((token) => insertTask(token, listId, task)),
      listTasks: (listId) => call((token) => listTasks(token, listId)),
      patchEvent: (calendarId, eventId, changes) =>
        call((token) => patchEvent(token, calendarId, eventId, changes)),
      patchTask: (listId, taskId, changes) =>
        call((token) => patchTask(token, listId, taskId, changes)),
      sweep: (options) => call((token) => sweep(token, options)),
    };
  });

export class LiveScratch extends Context.Service<LiveScratch, LiveScratchShape>()(
  'sync/testing/LiveScratch',
) {
  static readonly layer: Layer.Layer<LiveScratch, never, TokenManager> = Layer.effect(LiveScratch)(
    makeLiveScratch(LIVE_ACCOUNT_ID),
  );
}

/**
 * `engineLayer` from engine.http.test.ts with the live wire in place of the
 * fake: a fresh in-memory database per build, the real Google clients,
 * and the Apple/on-device seams stubbed as unavailable.
 */
export const liveEngineLayer = (config: LiveGoogleConfig) =>
  SyncEngine.layer.pipe(
    Layer.provideMerge(EventMutations.layer),
    Layer.provideMerge(appleCalendarServicesLayer(unavailableAppleCalendarClient('live'))),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(RemindersClient, unavailableRemindersClient('live'))),
    Layer.provideMerge(GoogleCalendarClient.layer),
    Layer.provideMerge(GoogleTasksClient.layer),
    Layer.provideMerge(GooglePeopleClient.layer),
    Layer.provideMerge(LiveScratch.layer),
    Layer.provideMerge(liveGoogleLayer(config)),
  );

/** A runtime for beforeAll/afterAll: the scratch service over the live wire, no database. */
export const makeScratchRuntime = (
  config: LiveGoogleConfig,
): ManagedRuntime.ManagedRuntime<LiveScratch | TokenManager, never> =>
  ManagedRuntime.make(LiveScratch.layer.pipe(Layer.provideMerge(liveGoogleLayer(config))));
