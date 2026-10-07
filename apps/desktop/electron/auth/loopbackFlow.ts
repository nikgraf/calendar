import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignInCancelledError } from '@calendar/core';
import {
  generatePkcePair,
  generateStateToken,
  TokenManager,
  type CodeExchangeResult,
} from '@calendar/google';
import { shell } from 'electron';
import { Cause, Data, Effect, Exit } from 'effect';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

export { GOOGLE_SCOPES } from '@calendar/google';
import { GOOGLE_SCOPES } from '@calendar/google';

export class AuthFlowError extends Data.TaggedError('AuthFlowError')<{
  readonly reason: string;
}> {}

const escapeHtml = (text: string): string =>
  text.replaceAll(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** The page the browser tab shows once the sign-in's outcome is known. */
const closingPage = (message: string): string => `<!doctype html><meta charset="utf-8">
<title>Solunivo</title>
<body style="font-family: system-ui; display: grid; place-items: center; height: 90vh">
  <p>${escapeHtml(message)}</p>
  <script>setTimeout(() => window.close(), 1500)</script>
</body>`;

const SIGNED_IN = 'Signed in — you can close this tab and return to Solunivo.';
const CANCELLED = 'Sign-in cancelled — you can close this tab.';
const failed = (why: string) => `Sign-in failed: ${why}. Return to Solunivo and try again.`;

const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

const isCancelled = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some(
    (reason) => Cause.isFailReason(reason) && reason.error instanceof SignInCancelledError,
  );

/** Google's answer on the loopback, held open until the outcome is known. */
interface Callback {
  readonly answer: (message: string) => void;
  readonly code: string;
  readonly redirectUri: string;
}

let cancelCurrent: (() => void) | undefined;

/**
 * The Accounts pane's Cancel while the browser is open (`auth:cancel`):
 * the flow ends as a SignInCancelledError instead of waiting out its five
 * minutes for a tab the user closed.
 */
export const cancelGoogleSignIn = (): void => {
  cancelCurrent?.();
};

/**
 * RFC 8252 loopback flow: one-shot HTTP server on 127.0.0.1:<random port>,
 * system browser via shell.openExternal (Google blocks embedded webviews),
 * PKCE + state validation, then code→token exchange via the TokenManager.
 *
 * The browser tab is answered only once the outcome is known — after the
 * code exchange. It used to say "Signed in" before a single check, over a
 * refused consent, a forged state or a failed exchange alike.
 * `loginHint` (a reconnect) opens Google on that account rather than the
 * account chooser.
 */
export const runGoogleSignIn = (
  clientId: string,
  options: { readonly loginHint?: string | undefined } = {},
): Effect.Effect<CodeExchangeResult, AuthFlowError | SignInCancelledError, TokenManager> =>
  Effect.gen(function* () {
    const tokenManager = yield* TokenManager;
    const pkce = yield* Effect.promise(() => generatePkcePair());
    const state = generateStateToken();
    // One flow at a time: a new one ends the one still waiting.
    cancelGoogleSignIn();

    const callback = yield* Effect.callback<Callback, AuthFlowError | SignInCancelledError>(
      (resume) => {
        let port = 0;
        let settled = false;
        const close = () => {
          settled = true;
          clearTimeout(timeout);
          server.close();
          if (cancelCurrent === cancel) {
            cancelCurrent = undefined;
          }
        };
        const finish = (outcome: Effect.Effect<Callback, AuthFlowError | SignInCancelledError>) => {
          if (!settled) {
            close();
            resume(outcome);
          }
        };
        const cancel = () =>
          finish(Effect.fail(new SignInCancelledError({ message: 'sign-in cancelled' })));

        const server = createServer((request, response) => {
          const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
          if (url.pathname !== '/callback' || settled) {
            response.writeHead(404).end();
            return;
          }
          const answer = (message: string) => {
            response
              .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
              .end(closingPage(message));
          };
          const error = url.searchParams.get('error');
          const code = url.searchParams.get('code');
          // State first: a callback this flow did not start reports nothing.
          if (url.searchParams.get('state') !== state) {
            answer(failed('this answer does not belong to the sign-in Solunivo started'));
            finish(Effect.fail(new AuthFlowError({ reason: 'state mismatch — possible CSRF' })));
          } else if (error === 'access_denied') {
            answer(CANCELLED);
            cancel();
          } else if (error) {
            answer(failed(`Google returned ${error}`));
            finish(Effect.fail(new AuthFlowError({ reason: `Google returned: ${error}` })));
          } else if (!code) {
            answer(failed('Google sent no authorization code'));
            finish(Effect.fail(new AuthFlowError({ reason: 'missing authorization code' })));
          } else {
            finish(
              Effect.succeed({ answer, code, redirectUri: `http://127.0.0.1:${port}/callback` }),
            );
          }
        });

        const timeout = setTimeout(
          () => finish(Effect.fail(new AuthFlowError({ reason: 'sign-in timed out' }))),
          FLOW_TIMEOUT_MS,
        );
        cancelCurrent = cancel;

        server.listen(0, '127.0.0.1', () => {
          port = (server.address() as AddressInfo).port;
          const authUrl = new URL(AUTH_ENDPOINT);
          authUrl.search = new URLSearchParams({
            access_type: 'offline',
            client_id: clientId,
            code_challenge: pkce.challenge,
            code_challenge_method: 'S256',
            ...(options.loginHint ? { login_hint: options.loginHint } : {}),
            // A reconnect skips the chooser; consent still returns a refresh token.
            prompt: options.loginHint ? 'consent' : 'consent select_account',
            redirect_uri: `http://127.0.0.1:${port}/callback`,
            response_type: 'code',
            scope: GOOGLE_SCOPES.join(' '),
            state,
          }).toString();
          void shell.openExternal(authUrl.toString());
        });
        // Interrupted (the app quitting): close the server, answer nothing.
        return Effect.sync(close);
      },
    );

    // Cancel stays in force through the code exchange — Accounts still
    // offers it, and a slow token endpoint must not add the account after
    // it was pressed: the exchange races the Cancel.
    let cancelExchange: (() => void) | undefined;
    const cancelled = new Promise<void>((resolve) => {
      cancelExchange = resolve;
    });
    cancelCurrent = cancelExchange;
    const exchange = tokenManager
      .exchangeCode({
        code: callback.code,
        codeVerifier: pkce.verifier,
        redirectUri: callback.redirectUri,
      })
      .pipe(
        Effect.catchTag('TokenRefreshError', (error) =>
          Effect.fail(new AuthFlowError({ reason: `code exchange failed: ${error.message}` })),
        ),
      );
    return yield* Effect.raceFirst(
      exchange,
      Effect.andThen(
        Effect.promise(() => cancelled),
        Effect.fail(new SignInCancelledError({ message: 'sign-in cancelled' })),
      ),
    ).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (cancelCurrent === cancelExchange) {
            cancelCurrent = undefined;
          }
          callback.answer(
            Exit.isSuccess(exit)
              ? SIGNED_IN
              : isCancelled(exit)
                ? CANCELLED
                : failed('the sign-in could not be completed'),
          );
        }),
      ),
    );
  });
