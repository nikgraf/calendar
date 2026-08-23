import { Effect, Schema } from 'effect';
import { HttpClient, HttpClientRequest, type HttpClientResponse } from 'effect/unstable/http';
import {
  ApiUnavailableError,
  ConflictError,
  GoogleApiError,
  InsufficientScopeError,
  NotFoundError,
  RateLimitedError,
  ReauthRequiredError,
  SyncTokenExpiredError,
  TokenRefreshError,
} from './errors.ts';
import { TokenManager } from './oauth/tokenManager.ts';

export type GoogleRequestError =
  | ApiUnavailableError
  | ConflictError
  | GoogleApiError
  | InsufficientScopeError
  | NotFoundError
  | RateLimitedError
  | ReauthRequiredError
  | SyncTokenExpiredError
  | TokenRefreshError;

/**
 * Ids for error messages. Calendar calls fill them literally; the tasks
 * client maps its own pair onto the same slots (calendarId ← taskListId,
 * eventId ← taskId) — the errors that embed them (404/412) only echo them
 * back as identifiers.
 */
export interface RequestContext {
  readonly calendarId?: string;
  readonly eventId?: string;
}

export const definedParams = (
  params: Record<string, number | string | undefined>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );

const retryAfterMs = (response: HttpClientResponse.HttpClientResponse): number | undefined => {
  const header = (response.headers as Record<string, string | undefined>)['retry-after'];
  const seconds = header ? Number(header) : Number.NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
};

export interface RequestCore {
  readonly executeAuthed: (
    accountId: string,
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    ApiUnavailableError | ReauthRequiredError | TokenRefreshError
  >;
  readonly failForStatus: (
    response: HttpClientResponse.HttpClientResponse,
    context: RequestContext,
  ) => Effect.Effect<never, GoogleRequestError>;
  readonly requestJson: <A, I>(
    accountId: string,
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.Codec<A, I>,
    context?: RequestContext,
  ) => Effect.Effect<A, GoogleRequestError>;
}

/**
 * The auth + status-mapping + decode stack shared by every Google API
 * client (Calendar, Tasks). Extracted from the calendar client verbatim,
 * plus one addition: a 403 whose body names an insufficient scope maps to
 * `InsufficientScopeError` instead of the generic `GoogleApiError` — the
 * generic 4xx is treated as permanent by the op queue and silently
 * dropped, which is exactly wrong for "re-consent needed".
 */
export const makeRequestCore: Effect.Effect<
  RequestCore,
  never,
  HttpClient.HttpClient | TokenManager
> = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const tokens = yield* TokenManager;

  const executeAuthed: RequestCore['executeAuthed'] = (accountId, request) =>
    Effect.gen(function* () {
      const send = (token: string) =>
        http
          .execute(HttpClientRequest.setHeader(request, 'authorization', `Bearer ${token}`))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.fail(new ApiUnavailableError({ cause: String(cause) })),
            ),
          );

      const token = yield* tokens.getAccessToken(accountId);
      const response = yield* send(token);
      if (response.status !== 401) {
        return response;
      }
      // Stale access token: force a refresh and retry exactly once.
      yield* tokens.invalidateAccessToken(accountId);
      const freshToken = yield* tokens.getAccessToken(accountId);
      const retried = yield* send(freshToken);
      if (retried.status === 401) {
        return yield* Effect.fail(new ReauthRequiredError({ accountId }));
      }
      return retried;
    });

  const failForStatus: RequestCore['failForStatus'] = (response, context) =>
    Effect.gen(function* () {
      const status = response.status;
      if (status === 410) {
        return yield* Effect.fail(
          new SyncTokenExpiredError({ calendarId: context.calendarId ?? '' }),
        );
      }
      if (status === 404) {
        return yield* Effect.fail(
          new NotFoundError({
            resource: context.eventId ?? context.calendarId ?? 'resource',
          }),
        );
      }
      if (status === 412) {
        return yield* Effect.fail(
          new ConflictError({
            calendarId: context.calendarId ?? '',
            eventId: context.eventId ?? '',
          }),
        );
      }
      if (status === 429) {
        return yield* Effect.fail(new RateLimitedError({ retryAfterMs: retryAfterMs(response) }));
      }
      const body = yield* response.json.pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (status === 403) {
        const text = JSON.stringify(body ?? '');
        if (text.includes('ateLimitExceeded')) {
          return yield* Effect.fail(new RateLimitedError({ retryAfterMs: retryAfterMs(response) }));
        }
        // A token that never carried the needed scope: refreshing cannot
        // fix it, only re-consent can.
        if (
          text.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') ||
          text.includes('insufficientPermissions')
        ) {
          return yield* Effect.fail(new InsufficientScopeError({ message: text }));
        }
      }
      if (status >= 500) {
        return yield* Effect.fail(new ApiUnavailableError({ cause: `http ${status}`, status }));
      }
      return yield* Effect.fail(
        new GoogleApiError({
          message: JSON.stringify(body ?? 'unknown error'),
          status,
        }),
      );
    });

  const requestJson: RequestCore['requestJson'] = (accountId, request, schema, context = {}) =>
    Effect.gen(function* () {
      const response = yield* executeAuthed(accountId, request);
      if (response.status >= 400) {
        return yield* failForStatus(response, context);
      }
      const body = yield* response.json.pipe(
        Effect.catchCause(() =>
          Effect.fail(
            new GoogleApiError({
              message: 'non-JSON response body',
              status: response.status,
            }),
          ),
        ),
      );
      return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.catchCause((cause) =>
          Effect.fail(
            new GoogleApiError({
              message: `unexpected payload: ${String(cause)}`,
              status: response.status,
            }),
          ),
        ),
      );
    });

  return { executeAuthed, failForStatus, requestJson };
});
