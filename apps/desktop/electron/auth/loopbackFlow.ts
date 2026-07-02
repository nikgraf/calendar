import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  generatePkcePair,
  generateStateToken,
  TokenManager,
  type CodeExchangeResult,
} from '@calendar/google';
import { shell } from 'electron';
import { Data, Effect } from 'effect';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

export class AuthFlowError extends Data.TaggedError('AuthFlowError')<{
  readonly reason: string;
}> {}

const CLOSING_PAGE = `<!doctype html><meta charset="utf-8">
<title>Calendar</title>
<body style="font-family: system-ui; display: grid; place-items: center; height: 90vh">
  <p>Signed in — you can close this tab and return to Calendar.</p>
  <script>setTimeout(() => window.close(), 1500)</script>
</body>`;

const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * RFC 8252 loopback flow: one-shot HTTP server on 127.0.0.1:<random port>,
 * system browser via shell.openExternal (Google blocks embedded webviews),
 * PKCE + state validation, then code→token exchange via the TokenManager.
 */
export const runGoogleSignIn = (
  clientId: string,
): Effect.Effect<CodeExchangeResult, AuthFlowError, TokenManager> =>
  Effect.gen(function* () {
    const tokenManager = yield* TokenManager;
    const pkce = yield* Effect.promise(() => generatePkcePair());
    const state = generateStateToken();

    const { code, redirectUri } = yield* Effect.tryPromise({
      catch: (cause) => new AuthFlowError({ reason: String(cause) }),
      try: () =>
        new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
          let port = 0;
          const server = createServer((request, response) => {
            const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
            if (url.pathname !== '/callback') {
              response.writeHead(404).end();
              return;
            }
            response
              .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
              .end(CLOSING_PAGE);
            server.close();
            clearTimeout(timeout);

            const returnedState = url.searchParams.get('state');
            const error = url.searchParams.get('error');
            const code = url.searchParams.get('code');
            if (error) {
              reject(new Error(`Google returned: ${error}`));
            } else if (returnedState !== state) {
              reject(new Error('state mismatch — possible CSRF'));
            } else if (!code) {
              reject(new Error('missing authorization code'));
            } else {
              resolve({
                code,
                redirectUri: `http://127.0.0.1:${port}/callback`,
              });
            }
          });

          const timeout = setTimeout(() => {
            server.close();
            reject(new Error('sign-in timed out'));
          }, FLOW_TIMEOUT_MS);

          server.listen(0, '127.0.0.1', () => {
            port = (server.address() as AddressInfo).port;
            const authUrl = new URL(AUTH_ENDPOINT);
            authUrl.search = new URLSearchParams({
              access_type: 'offline',
              client_id: clientId,
              code_challenge: pkce.challenge,
              code_challenge_method: 'S256',
              prompt: 'consent select_account',
              redirect_uri: `http://127.0.0.1:${port}/callback`,
              response_type: 'code',
              scope: GOOGLE_SCOPES.join(' '),
              state,
            }).toString();
            void shell.openExternal(authUrl.toString());
          });
        }),
    });

    return yield* tokenManager
      .exchangeCode({ code, codeVerifier: pkce.verifier, redirectUri })
      .pipe(
        Effect.catchTag('TokenRefreshError', (error) =>
          Effect.fail(new AuthFlowError({ reason: `code exchange failed: ${error.message}` })),
        ),
      );
  });
