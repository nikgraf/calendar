import { randomUUID } from 'node:crypto';
import { Account, handleBackendInvoke, type BackendHandlers } from '@calendar/core';
import {
  GoogleCalendarClient,
  GoogleOAuthConfig,
  mapGcalCalendar,
  TokenManager,
  TokenStore,
} from '@calendar/google';
import { ipcMain } from 'electron';
import { Data, Effect, Layer, ManagedRuntime } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { AccountsStore } from './accountsFile.ts';
import { runGoogleSignIn } from './auth/loopbackFlow.ts';
import { loadOAuthConfig } from './oauthConfig.ts';
import { safeStorageTokenStore } from './tokens/safeStorageStore.ts';

class OAuthNotConfiguredError extends Data.TaggedError('OAuthNotConfiguredError')<{
  readonly message: string;
}> {}

/**
 * Builds the main-process backend: the full Layer stack and the AppBackend
 * handler map, exposed to the renderer over the single 'backend' IPC channel.
 */
export const startBackendHost = (): void => {
  const oauth = loadOAuthConfig();

  const baseLayer = Layer.mergeAll(
    AccountsStore.layer,
    safeStorageTokenStore,
    FetchHttpClient.layer,
  );
  const googleLayer = Layer.mergeAll(
    TokenManager.layer,
    GoogleCalendarClient.layer.pipe(Layer.provide(TokenManager.layer)),
  ).pipe(
    Layer.provide(baseLayer),
    Layer.provide(
      GoogleOAuthConfig.layer({
        clientId: oauth?.clientId ?? 'unconfigured',
        ...(oauth?.clientSecret ? { clientSecret: oauth.clientSecret } : {}),
      }),
    ),
  );
  const runtime = ManagedRuntime.make(Layer.provideMerge(googleLayer, baseLayer));

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
    AccountsStore | GoogleCalendarClient | TokenManager | TokenStore
  > = {
    addAccount: () =>
      Effect.gen(function* () {
        const config = yield* requireOAuth;
        const accounts = yield* AccountsStore;
        const tokenStore = yield* TokenStore;

        const result = yield* runGoogleSignIn(config.clientId);
        const existing = (yield* accounts.list()).find(
          (account) => account.email === result.profile.email,
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
        yield* accounts.add(account);
        return account;
      }),

    listAccounts: () =>
      Effect.gen(function* () {
        const accounts = yield* AccountsStore;
        return yield* accounts.list();
      }),

    listCalendars: ({ accountId }) =>
      Effect.gen(function* () {
        const accounts = yield* AccountsStore;
        const client = yield* GoogleCalendarClient;
        const all = yield* accounts.list();
        const selected = accountId ? all.filter((account) => account.id === accountId) : all;

        const results = [];
        for (const account of selected) {
          const page = yield* client.listCalendars({ accountId: account.id });
          for (const entry of page.items ?? []) {
            if (entry.deleted) {
              continue;
            }
            results.push(
              mapGcalCalendar(entry, {
                accountId: account.id,
                colorFromId: () => undefined,
              }),
            );
          }
        }
        return results;
      }),

    removeAccount: ({ accountId }) =>
      Effect.gen(function* () {
        const accounts = yield* AccountsStore;
        const tokenStore = yield* TokenStore;
        yield* tokenStore.remove(accountId);
        yield* accounts.remove(accountId);
      }),
  };

  ipcMain.handle('backend', (_event, method: string, payload: unknown) =>
    runtime.runPromise(handleBackendInvoke(handlers, method, payload)),
  );
};
