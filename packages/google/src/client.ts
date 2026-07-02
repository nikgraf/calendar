import { Context, Effect, Layer, Schema } from 'effect';
import { HttpClient, HttpClientRequest, type HttpClientResponse } from 'effect/unstable/http';
import {
  GcalCalendarListPage,
  GcalColors,
  GcalEvent,
  GcalEventsPage,
  type GcalEventInput,
} from './apiTypes.ts';
import {
  ApiUnavailableError,
  ConflictError,
  GoogleApiError,
  NotFoundError,
  RateLimitedError,
  ReauthRequiredError,
  SyncTokenExpiredError,
  TokenRefreshError,
} from './errors.ts';
import { TokenManager } from './oauth/tokenManager.ts';

const BASE_URL = 'https://www.googleapis.com/calendar/v3';

export type GoogleRequestError =
  | ApiUnavailableError
  | ConflictError
  | GoogleApiError
  | NotFoundError
  | RateLimitedError
  | ReauthRequiredError
  | SyncTokenExpiredError
  | TokenRefreshError;

export interface ListEventsParams {
  readonly maxResults?: number;
  readonly pageToken?: string;
  readonly syncToken?: string;
  readonly timeMax?: string;
  readonly timeMin?: string;
}

export interface GoogleCalendarClientShape {
  readonly deleteEvent: (params: {
    readonly accountId: string;
    readonly baseEtag?: string | undefined;
    readonly calendarId: string;
    readonly eventId: string;
  }) => Effect.Effect<void, GoogleRequestError>;
  readonly getColors: (accountId: string) => Effect.Effect<GcalColors, GoogleRequestError>;
  readonly insertEvent: (params: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly event: GcalEventInput;
  }) => Effect.Effect<GcalEvent, GoogleRequestError>;
  readonly listCalendars: (params: {
    readonly accountId: string;
    readonly pageToken?: string | undefined;
    readonly syncToken?: string | undefined;
  }) => Effect.Effect<GcalCalendarListPage, GoogleRequestError>;
  readonly listEvents: (params: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly params: ListEventsParams;
  }) => Effect.Effect<GcalEventsPage, GoogleRequestError>;
  readonly patchEvent: (params: {
    readonly accountId: string;
    readonly baseEtag?: string | undefined;
    readonly calendarId: string;
    readonly event: Partial<GcalEventInput>;
    readonly eventId: string;
  }) => Effect.Effect<GcalEvent, GoogleRequestError>;
}

type StatusError = GoogleRequestError;

const definedParams = (
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

const make: Effect.Effect<GoogleCalendarClientShape, never, HttpClient.HttpClient | TokenManager> =
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const tokens = yield* TokenManager;

    const executeAuthed = (
      accountId: string,
      request: HttpClientRequest.HttpClientRequest,
    ): Effect.Effect<
      HttpClientResponse.HttpClientResponse,
      ApiUnavailableError | ReauthRequiredError | TokenRefreshError
    > =>
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

    const failForStatus = (
      response: HttpClientResponse.HttpClientResponse,
      context: { readonly calendarId?: string; readonly eventId?: string },
    ): Effect.Effect<never, StatusError> =>
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
        if (status === 403 && JSON.stringify(body ?? '').includes('ateLimitExceeded')) {
          return yield* Effect.fail(new RateLimitedError({ retryAfterMs: retryAfterMs(response) }));
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

    const requestJson = <A, I>(
      accountId: string,
      request: HttpClientRequest.HttpClientRequest,
      schema: Schema.Codec<A, I>,
      context: { readonly calendarId?: string; readonly eventId?: string } = {},
    ): Effect.Effect<A, StatusError> =>
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

    const eventsUrl = (calendarId: string, suffix = ''): string =>
      `${BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events${suffix}`;

    const shape: GoogleCalendarClientShape = {
      deleteEvent: ({ accountId, baseEtag, calendarId, eventId }) =>
        Effect.gen(function* () {
          let request = HttpClientRequest.delete(
            eventsUrl(calendarId, `/${encodeURIComponent(eventId)}`),
          );
          if (baseEtag) {
            request = HttpClientRequest.setHeader(request, 'if-match', baseEtag);
          }
          const response = yield* executeAuthed(accountId, request);
          if (response.status >= 400) {
            return yield* failForStatus(response, { calendarId, eventId });
          }
        }),

      getColors: (accountId) =>
        requestJson(accountId, HttpClientRequest.get(`${BASE_URL}/colors`), GcalColors),

      insertEvent: ({ accountId, calendarId, event }) =>
        requestJson(
          accountId,
          HttpClientRequest.post(eventsUrl(calendarId)).pipe(
            HttpClientRequest.bodyJsonUnsafe(event),
          ),
          GcalEvent,
          { calendarId },
        ),

      listCalendars: ({ accountId, pageToken, syncToken }) =>
        requestJson(
          accountId,
          HttpClientRequest.get(`${BASE_URL}/users/me/calendarList`).pipe(
            HttpClientRequest.setUrlParams(
              definedParams({
                maxResults: 250,
                pageToken,
                showDeleted: 'true',
                syncToken,
              }),
            ),
          ),
          GcalCalendarListPage,
        ),

      listEvents: ({ accountId, calendarId, params }) =>
        requestJson(
          accountId,
          HttpClientRequest.get(eventsUrl(calendarId)).pipe(
            HttpClientRequest.setUrlParams(
              definedParams({
                maxResults: params.maxResults ?? 2500,
                pageToken: params.pageToken,
                showDeleted: 'true',
                // Sync tokens encode the original filters; incremental calls
                // must send the token alone.
                ...(params.syncToken
                  ? { syncToken: params.syncToken }
                  : {
                      singleEvents: 'false',
                      timeMax: params.timeMax,
                      timeMin: params.timeMin,
                    }),
              }),
            ),
          ),
          GcalEventsPage,
          { calendarId },
        ),

      patchEvent: ({ accountId, baseEtag, calendarId, event, eventId }) => {
        let request = HttpClientRequest.patch(
          eventsUrl(calendarId, `/${encodeURIComponent(eventId)}`),
        ).pipe(HttpClientRequest.bodyJsonUnsafe(event));
        if (baseEtag) {
          request = HttpClientRequest.setHeader(request, 'if-match', baseEtag);
        }
        return requestJson(accountId, request, GcalEvent, {
          calendarId,
          eventId,
        });
      },
    };

    return shape;
  });

export class GoogleCalendarClient extends Context.Service<
  GoogleCalendarClient,
  GoogleCalendarClientShape
>()('google/CalendarClient') {
  static readonly layer: Layer.Layer<
    GoogleCalendarClient,
    never,
    HttpClient.HttpClient | TokenManager
  > = Layer.effect(GoogleCalendarClient)(make);
}
