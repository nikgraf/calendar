import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http';
import { describe } from 'vitest';
import { GoogleCalendarClient } from './client.ts';
import { TokenManager, type TokenManagerShape } from './oauth/tokenManager.ts';

interface StubResponse {
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly status?: number;
}

const stubTokenManager: TokenManagerShape = {
  exchangeCode: () => Effect.die('not used'),
  getAccessToken: () => Effect.succeed('access-token'),
  invalidateAccessToken: () => Effect.void,
};

const clientLayer = (
  responses: Array<StubResponse>,
  recorded: Array<HttpClientRequest.HttpClientRequest>,
): Layer.Layer<GoogleCalendarClient> =>
  GoogleCalendarClient.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            recorded.push(request);
            const next = responses.shift() ?? { status: 500 };
            const status = next.status ?? 200;
            return HttpClientResponse.fromWeb(
              request,
              new Response(status === 204 ? null : JSON.stringify(next.body ?? {}), {
                headers: {
                  'content-type': 'application/json',
                  ...next.headers,
                },
                status,
              }),
            );
          }),
        ),
      ),
    ),
    Layer.provide(Layer.succeed(TokenManager, stubTokenManager)),
  );

const params = (request: HttpClientRequest.HttpClientRequest): URLSearchParams =>
  new URLSearchParams(
    request.urlParams.params.map(([key, value]) => [key, value] as [string, string]),
  );

describe('GoogleCalendarClient', () => {
  it.effect('sends only the syncToken on incremental listEvents', () => {
    const recorded: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const client = yield* GoogleCalendarClient;
      yield* client.listEvents({
        accountId: 'acc',
        calendarId: 'cal@group.calendar.google.com',
        params: { syncToken: 'sync-123', timeMin: 'should-be-ignored' },
      });

      const sent = params(recorded[0]!);
      expect(sent.get('syncToken')).toBe('sync-123');
      expect(sent.get('timeMin')).toBeNull();
      expect(sent.get('singleEvents')).toBeNull();
      expect(recorded[0]!.url).toContain('/calendars/cal%40group.calendar.google.com/events');
      expect(recorded[0]!.headers['authorization']).toBe('Bearer access-token');
    }).pipe(Effect.provide(clientLayer([{ body: { items: [] } }], recorded)));
  });

  it.effect('sends window params (not syncToken) on initial listEvents', () => {
    const recorded: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const client = yield* GoogleCalendarClient;
      const page = yield* client.listEvents({
        accountId: 'acc',
        calendarId: 'primary',
        params: { timeMax: '2027-01-01T00:00:00Z', timeMin: '2026-01-01T00:00:00Z' },
      });

      const sent = params(recorded[0]!);
      expect(sent.get('timeMin')).toBe('2026-01-01T00:00:00Z');
      expect(sent.get('singleEvents')).toBe('false');
      expect(sent.get('maxResults')).toBe('2500');
      expect(sent.get('showDeleted')).toBe('true');
      expect(page.nextSyncToken).toBe('fresh-token');
    }).pipe(
      Effect.provide(
        clientLayer([{ body: { items: [], nextSyncToken: 'fresh-token' } }], recorded),
      ),
    );
  });

  it.effect('maps 410 to SyncTokenExpiredError', () =>
    Effect.gen(function* () {
      const client = yield* GoogleCalendarClient;
      const error = yield* client
        .listEvents({ accountId: 'acc', calendarId: 'primary', params: {} })
        .pipe(Effect.flip);
      expect(error._tag).toBe('SyncTokenExpiredError');
    }).pipe(Effect.provide(clientLayer([{ status: 410 }], []))),
  );

  it.effect('maps 412 to ConflictError on patch', () =>
    Effect.gen(function* () {
      const client = yield* GoogleCalendarClient;
      const error = yield* client
        .patchEvent({
          accountId: 'acc',
          baseEtag: '"etag-1"',
          calendarId: 'primary',
          event: { summary: 'new title' },
          eventId: 'evt1',
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe('ConflictError');
    }).pipe(Effect.provide(clientLayer([{ status: 412 }], []))),
  );

  it.effect('sends If-Match and body on patch', () => {
    const recorded: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const client = yield* GoogleCalendarClient;
      yield* client.patchEvent({
        accountId: 'acc',
        baseEtag: '"etag-1"',
        calendarId: 'primary',
        event: { summary: 'new title' },
        eventId: 'evt1',
      });
      expect(recorded[0]!.method).toBe('PATCH');
      expect(recorded[0]!.headers['if-match']).toBe('"etag-1"');
      expect(recorded[0]!.url).toContain('/events/evt1');
    }).pipe(Effect.provide(clientLayer([{ body: { id: 'evt1' } }], recorded)));
  });

  it.effect('adds sendUpdates=all to insert and patch only when asked', () => {
    const recorded: Array<HttpClientRequest.HttpClientRequest> = [];
    const event = {
      end: { dateTime: '2026-07-02T13:00:00Z' },
      start: { dateTime: '2026-07-02T12:00:00Z' },
      summary: 'Sync',
    };
    return Effect.gen(function* () {
      const client = yield* GoogleCalendarClient;
      yield* client.insertEvent({ accountId: 'acc', calendarId: 'primary', event });
      yield* client.insertEvent({
        accountId: 'acc',
        calendarId: 'primary',
        event,
        sendUpdates: 'all',
      });
      yield* client.patchEvent({
        accountId: 'acc',
        calendarId: 'primary',
        event,
        eventId: 'evt1',
        sendUpdates: 'all',
      });
      expect(params(recorded[0]!).get('sendUpdates')).toBeNull();
      expect(params(recorded[1]!).get('sendUpdates')).toBe('all');
      expect(recorded[2]!.method).toBe('PATCH');
      expect(params(recorded[2]!).get('sendUpdates')).toBe('all');
    }).pipe(
      Effect.provide(
        clientLayer(
          [{ body: { id: 'a' } }, { body: { id: 'b' } }, { body: { id: 'evt1' } }],
          recorded,
        ),
      ),
    );
  });

  it.effect('maps 429 with Retry-After to RateLimitedError', () =>
    Effect.gen(function* () {
      const client = yield* GoogleCalendarClient;
      const error = yield* client.listCalendars({ accountId: 'acc' }).pipe(Effect.flip);
      expect(error._tag).toBe('RateLimitedError');
      if (error._tag === 'RateLimitedError') {
        expect(error.retryAfterMs).toBe(7000);
      }
    }).pipe(Effect.provide(clientLayer([{ headers: { 'retry-after': '7' }, status: 429 }], []))),
  );

  it.effect('retries exactly once after a 401 with a fresh token', () => {
    const recorded: Array<HttpClientRequest.HttpClientRequest> = [];
    const grantedTokens = ['stale', 'fresh'];
    let invalidated = 0;
    const rotatingTokens: TokenManagerShape = {
      ...stubTokenManager,
      getAccessToken: () => Effect.succeed(grantedTokens.shift() ?? 'exhausted'),
      invalidateAccessToken: () =>
        Effect.sync(() => {
          invalidated += 1;
        }),
    };
    return Effect.gen(function* () {
      const client = yield* GoogleCalendarClient;
      const page = yield* client.listCalendars({ accountId: 'acc' });
      expect(page.items).toEqual([]);
      expect(recorded).toHaveLength(2);
      expect(recorded[0]!.headers['authorization']).toBe('Bearer stale');
      expect(recorded[1]!.headers['authorization']).toBe('Bearer fresh');
      expect(invalidated).toBe(1);
    }).pipe(
      Effect.provide(
        GoogleCalendarClient.layer.pipe(
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.sync(() => {
                  recorded.push(request);
                  return HttpClientResponse.fromWeb(
                    request,
                    new Response(JSON.stringify(recorded.length === 1 ? {} : { items: [] }), {
                      headers: { 'content-type': 'application/json' },
                      status: recorded.length === 1 ? 401 : 200,
                    }),
                  );
                }),
              ),
            ),
          ),
          Layer.provide(Layer.succeed(TokenManager, rotatingTokens)),
        ),
      ),
    );
  });

  it.effect('deleteEvent succeeds on 204 and maps 404', () => {
    const recorded: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const client = yield* GoogleCalendarClient;
      yield* client.deleteEvent({
        accountId: 'acc',
        calendarId: 'primary',
        eventId: 'evt1',
      });
      expect(recorded[0]!.method).toBe('DELETE');

      const error = yield* client
        .deleteEvent({ accountId: 'acc', calendarId: 'primary', eventId: 'gone' })
        .pipe(Effect.flip);
      expect(error._tag).toBe('NotFoundError');
    }).pipe(Effect.provide(clientLayer([{ status: 204 }, { status: 404 }], recorded)));
  });
});
