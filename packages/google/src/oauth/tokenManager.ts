import { TokenSet } from '@calendar/core/types';
import { Clock, Context, Effect, Layer, Schema, Semaphore } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { ReauthRequiredError, TokenRefreshError } from '../errors.ts';
import { TokenStore } from './tokenStore.ts';

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Refresh this long before the recorded expiry to absorb clock skew. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export class GoogleOAuthConfig extends Context.Service<
  GoogleOAuthConfig,
  {
    readonly clientId: string;
    /** Desktop-app client secret — non-confidential by design (RFC 8252). */
    readonly clientSecret?: string | undefined;
    /** Overridable for tests. */
    readonly tokenEndpoint: string;
  }
>()('google/OAuthConfig') {
  static readonly layer = (config: {
    clientId: string;
    clientSecret?: string;
    tokenEndpoint?: string;
  }): Layer.Layer<GoogleOAuthConfig> =>
    Layer.succeed(GoogleOAuthConfig, {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      tokenEndpoint: config.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT,
    });
}

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
  id_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
});
type TokenResponse = Schema.Schema.Type<typeof TokenResponse>;

export interface GoogleProfile {
  readonly avatarUrl?: string | undefined;
  readonly displayName?: string | undefined;
  readonly email: string;
}

export interface CodeExchangeResult {
  readonly profile: GoogleProfile;
  readonly tokens: TokenSet;
}

export interface TokenManagerShape {
  /**
   * Exchanges an authorization code (PKCE) for tokens and the account's
   * profile. The caller persists the tokens under a new account id.
   */
  readonly exchangeCode: (params: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }) => Effect.Effect<CodeExchangeResult, TokenRefreshError>;
  /**
   * Returns a valid access token, refreshing (single-flight per account)
   * when it expires within the skew window.
   */
  readonly getAccessToken: (
    accountId: string,
  ) => Effect.Effect<string, ReauthRequiredError | TokenRefreshError>;
  /** Drops the cached expiry so the next call refreshes (after a 401). */
  readonly invalidateAccessToken: (accountId: string) => Effect.Effect<void>;
}

/** Decodes the payload of a Google id_token (already trusted: fetched over TLS). */
const parseIdToken = (idToken: string): GoogleProfile | null => {
  const payload = idToken.split('.')[1];
  if (!payload) {
    return null;
  }
  try {
    const decoded = JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/'))) as {
      email?: string;
      name?: string;
      picture?: string;
    };
    return decoded.email
      ? {
          avatarUrl: decoded.picture,
          displayName: decoded.name,
          email: decoded.email,
        }
      : null;
  } catch {
    return null;
  }
};

const make: Effect.Effect<
  TokenManagerShape,
  never,
  GoogleOAuthConfig | HttpClient.HttpClient | TokenStore
> = Effect.gen(function* () {
  const store = yield* TokenStore;
  const config = yield* GoogleOAuthConfig;
  const client = yield* HttpClient.HttpClient;

  const locks = new Map<string, Semaphore.Semaphore>();
  const lockFor = (accountId: string): Semaphore.Semaphore => {
    let lock = locks.get(accountId);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(accountId, lock);
    }
    return lock;
  };

  const postToken = (
    form: Record<string, string>,
    onError: (message: string) => TokenRefreshError,
  ): Effect.Effect<TokenResponse, TokenRefreshError> =>
    Effect.gen(function* () {
      const request = HttpClientRequest.post(config.tokenEndpoint).pipe(
        HttpClientRequest.bodyText(
          new URLSearchParams(form).toString(),
          'application/x-www-form-urlencoded',
        ),
      );
      const response = yield* client
        .execute(request)
        .pipe(Effect.catchCause(() => Effect.fail(onError('token endpoint unreachable'))));
      const body = yield* response.json.pipe(
        Effect.catchCause(() => Effect.fail(onError('token endpoint returned a non-JSON body'))),
      );
      if (response.status >= 400) {
        const errorCode =
          typeof body === 'object' && body !== null && 'error' in body
            ? String((body as { error: unknown }).error)
            : `http ${response.status}`;
        return yield* Effect.fail(onError(errorCode));
      }
      return yield* Schema.decodeUnknownEffect(TokenResponse)(body).pipe(
        Effect.catchCause(() => Effect.fail(onError('unexpected token endpoint payload'))),
      );
    });

  const secretField = config.clientSecret ? { client_secret: config.clientSecret } : {};

  const refresh = (
    accountId: string,
    tokens: TokenSet,
  ): Effect.Effect<TokenSet, ReauthRequiredError | TokenRefreshError> =>
    Effect.gen(function* () {
      const response = yield* postToken(
        {
          client_id: config.clientId,
          grant_type: 'refresh_token',
          refresh_token: tokens.refreshToken,
          ...secretField,
        },
        (message) => new TokenRefreshError({ accountId, message }),
      ).pipe(
        Effect.catchIf(
          (error): error is TokenRefreshError => error.message === 'invalid_grant',
          () => Effect.fail(new ReauthRequiredError({ accountId })),
        ),
      );
      const now = yield* Clock.currentTimeMillis;
      const updated = new TokenSet({
        accessToken: response.access_token,
        expiresAt: now + response.expires_in * 1000,
        refreshToken: response.refresh_token ?? tokens.refreshToken,
        scopes: response.scope?.split(' ') ?? tokens.scopes,
      });
      yield* store.set(accountId, updated);
      return updated;
    });

  const shape: TokenManagerShape = {
    exchangeCode: ({ code, codeVerifier, redirectUri }) =>
      Effect.gen(function* () {
        const response = yield* postToken(
          {
            client_id: config.clientId,
            code,
            code_verifier: codeVerifier,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
            ...secretField,
          },
          (message) => new TokenRefreshError({ accountId: 'new-account', message }),
        );
        if (!response.refresh_token) {
          return yield* Effect.fail(
            new TokenRefreshError({
              accountId: 'new-account',
              message: 'no refresh_token in code exchange response',
            }),
          );
        }
        const profile = response.id_token ? parseIdToken(response.id_token) : null;
        if (!profile) {
          return yield* Effect.fail(
            new TokenRefreshError({
              accountId: 'new-account',
              message: 'missing or unparsable id_token',
            }),
          );
        }
        const now = yield* Clock.currentTimeMillis;
        return {
          profile,
          tokens: new TokenSet({
            accessToken: response.access_token,
            expiresAt: now + response.expires_in * 1000,
            refreshToken: response.refresh_token,
            scopes: response.scope?.split(' ') ?? [],
          }),
        };
      }),

    getAccessToken: (accountId) =>
      lockFor(accountId).withPermits(1)(
        Effect.gen(function* () {
          const tokens = yield* store.get(accountId);
          if (!tokens) {
            return yield* Effect.fail(new ReauthRequiredError({ accountId }));
          }
          const now = yield* Clock.currentTimeMillis;
          if (tokens.expiresAt - EXPIRY_SKEW_MS > now) {
            return tokens.accessToken;
          }
          const refreshed = yield* refresh(accountId, tokens);
          return refreshed.accessToken;
        }),
      ),

    invalidateAccessToken: (accountId) =>
      Effect.gen(function* () {
        const tokens = yield* store.get(accountId);
        if (tokens) {
          yield* store.set(accountId, new TokenSet({ ...tokens, expiresAt: 0 }));
        }
      }),
  };

  return shape;
});

export class TokenManager extends Context.Service<TokenManager, TokenManagerShape>()(
  'google/TokenManager',
) {
  static readonly layer: Layer.Layer<
    TokenManager,
    never,
    GoogleOAuthConfig | HttpClient.HttpClient | TokenStore
  > = Layer.effect(TokenManager)(make);
}
