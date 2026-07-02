import { TokenSet } from '@calendar/core/types';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse, type HttpBody } from 'effect/unstable/http';
import { describe } from 'vitest';
import { GoogleOAuthConfig, TokenManager } from './tokenManager.ts';
import { TokenStore } from './tokenStore.ts';

interface RecordedRequest {
  readonly form: URLSearchParams;
  readonly url: string;
}

const requestBodyText = (body: HttpBody.HttpBody): string =>
  body._tag === 'Uint8Array' ? new TextDecoder().decode(body.body as Uint8Array) : '';

/** An HttpClient whose responses come from a queue; records each request. */
const stubHttp = (
  responses: Array<{ body: unknown; status?: number }>,
  recorded: Array<RecordedRequest>,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        recorded.push({
          form: new URLSearchParams(requestBodyText(request.body)),
          url: request.url,
        });
        const next = responses.shift() ?? { body: {}, status: 500 };
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(next.body), {
            headers: { 'content-type': 'application/json' },
            status: next.status ?? 200,
          }),
        );
      }),
    ),
  );

const configLayer = GoogleOAuthConfig.layer({
  clientId: 'test-client',
  tokenEndpoint: 'https://token.test/exchange',
});

const managerLayer = (
  responses: Array<{ body: unknown; status?: number }>,
  recorded: Array<RecordedRequest> = [],
): Layer.Layer<TokenManager | TokenStore> =>
  TokenManager.layer.pipe(
    Layer.provideMerge(TokenStore.layerMemory),
    Layer.provide(stubHttp(responses, recorded)),
    Layer.provide(configLayer),
  );

const storedTokens = (expiresAt: number): TokenSet =>
  new TokenSet({
    accessToken: 'old-access',
    expiresAt,
    refreshToken: 'refresh-1',
    scopes: ['calendar'],
  });

const base64UrlJson = (value: unknown): string =>
  btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

describe('TokenManager', () => {
  it.effect('returns the stored token while it is fresh', () => {
    const recorded: Array<RecordedRequest> = [];
    return Effect.gen(function* () {
      const manager = yield* TokenManager;
      const store = yield* TokenStore;
      yield* store.set('acc-1', storedTokens(Date.now() + 60 * 60 * 1000));

      const token = yield* manager.getAccessToken('acc-1');
      expect(token).toBe('old-access');
      expect(recorded).toHaveLength(0);
    }).pipe(Effect.provide(managerLayer([], recorded)));
  });

  it.effect('refreshes an expired token with the right grant and persists', () => {
    const recorded: Array<RecordedRequest> = [];
    return Effect.gen(function* () {
      const manager = yield* TokenManager;
      const store = yield* TokenStore;
      yield* store.set('acc-1', storedTokens(0));

      const token = yield* manager.getAccessToken('acc-1');
      expect(token).toBe('new-access');

      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.url).toBe('https://token.test/exchange');
      expect(recorded[0]!.form.get('grant_type')).toBe('refresh_token');
      expect(recorded[0]!.form.get('refresh_token')).toBe('refresh-1');
      expect(recorded[0]!.form.get('client_id')).toBe('test-client');

      const persisted = yield* store.get('acc-1');
      expect(persisted?.accessToken).toBe('new-access');
      expect(persisted?.refreshToken).toBe('refresh-1');
    }).pipe(
      Effect.provide(
        managerLayer([{ body: { access_token: 'new-access', expires_in: 3600 } }], recorded),
      ),
    );
  });

  it.effect('deduplicates concurrent refreshes (single flight)', () => {
    const recorded: Array<RecordedRequest> = [];
    return Effect.gen(function* () {
      const manager = yield* TokenManager;
      const store = yield* TokenStore;
      yield* store.set('acc-1', storedTokens(0));

      const [first, second] = yield* Effect.all(
        [manager.getAccessToken('acc-1'), manager.getAccessToken('acc-1')],
        { concurrency: 'unbounded' },
      );
      expect(first).toBe('new-access');
      expect(second).toBe('new-access');
      expect(recorded).toHaveLength(1);
    }).pipe(
      Effect.provide(
        managerLayer(
          [
            { body: { access_token: 'new-access', expires_in: 3600 } },
            { body: { access_token: 'should-not-happen', expires_in: 3600 } },
          ],
          recorded,
        ),
      ),
    );
  });

  it.effect('maps invalid_grant to ReauthRequiredError', () =>
    Effect.gen(function* () {
      const manager = yield* TokenManager;
      const store = yield* TokenStore;
      yield* store.set('acc-1', storedTokens(0));

      const error = yield* manager.getAccessToken('acc-1').pipe(Effect.flip);
      expect(error._tag).toBe('ReauthRequiredError');
    }).pipe(Effect.provide(managerLayer([{ body: { error: 'invalid_grant' }, status: 400 }]))),
  );

  it.effect('fails with ReauthRequiredError when no tokens are stored', () =>
    Effect.gen(function* () {
      const manager = yield* TokenManager;
      const error = yield* manager.getAccessToken('unknown').pipe(Effect.flip);
      expect(error._tag).toBe('ReauthRequiredError');
    }).pipe(Effect.provide(managerLayer([]))),
  );

  it.effect('exchangeCode sends the PKCE grant and parses the profile', () => {
    const recorded: Array<RecordedRequest> = [];
    return Effect.gen(function* () {
      const manager = yield* TokenManager;
      const result = yield* manager.exchangeCode({
        code: 'auth-code',
        codeVerifier: 'verifier-123',
        redirectUri: 'http://127.0.0.1:1234',
      });

      expect(recorded[0]!.form.get('grant_type')).toBe('authorization_code');
      expect(recorded[0]!.form.get('code')).toBe('auth-code');
      expect(recorded[0]!.form.get('code_verifier')).toBe('verifier-123');
      expect(result.profile.email).toBe('nik@example.com');
      expect(result.profile.displayName).toBe('Nik');
      expect(result.tokens.refreshToken).toBe('refresh-new');
      expect(result.tokens.scopes).toEqual(['calendar', 'openid']);
    }).pipe(
      Effect.provide(
        managerLayer(
          [
            {
              body: {
                access_token: 'access-new',
                expires_in: 3600,
                id_token: `x.${base64UrlJson({
                  email: 'nik@example.com',
                  name: 'Nik',
                })}.y`,
                refresh_token: 'refresh-new',
                scope: 'calendar openid',
              },
            },
          ],
          recorded,
        ),
      ),
    );
  });
});
