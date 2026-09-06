import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http';
import { describe } from 'vitest';
import { TokenManager, type TokenManagerShape } from './oauth/tokenManager.ts';
import { GooglePeopleClient } from './peopleClient.ts';

interface StubResponse {
  readonly body?: unknown;
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
): Layer.Layer<GooglePeopleClient> =>
  GooglePeopleClient.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            recorded.push(request);
            const next = responses.shift() ?? { status: 500 };
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(next.body ?? {}), {
                headers: { 'content-type': 'application/json' },
                status: next.status ?? 200,
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

describe('GooglePeopleClient', () => {
  it.effect('lists connections with personFields and asks for a sync token', () => {
    const recorded: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const client = yield* GooglePeopleClient;
      const page = yield* client.listConnections({ accountId: 'acc' });
      expect(page.nextSyncToken).toBe('tok-1');
      expect(recorded[0]!.url).toContain('/v1/people/me/connections');
      const query = params(recorded[0]!);
      expect(query.get('personFields')).toBe('names,emailAddresses');
      expect(query.get('readMask')).toBeNull();
      expect(query.get('requestSyncToken')).toBe('true');
      expect(query.get('pageSize')).toBe('1000');
      expect(query.get('syncToken')).toBeNull();
      expect(recorded[0]!.headers['authorization']).toBe('Bearer access-token');
    }).pipe(
      Effect.provide(
        clientLayer(
          [{ body: { connections: [{ resourceName: 'people/c1' }], nextSyncToken: 'tok-1' } }],
          recorded,
        ),
      ),
    );
  });

  it.effect('lists other contacts with readMask and forwards sync + page tokens', () => {
    const recorded: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const client = yield* GooglePeopleClient;
      yield* client.listOtherContacts({ accountId: 'acc', pageToken: 'p2', syncToken: 'tok-1' });
      expect(recorded[0]!.url).toContain('/v1/otherContacts');
      const query = params(recorded[0]!);
      expect(query.get('readMask')).toBe('names,emailAddresses');
      expect(query.get('personFields')).toBeNull();
      expect(query.get('syncToken')).toBe('tok-1');
      expect(query.get('pageToken')).toBe('p2');
    }).pipe(Effect.provide(clientLayer([{ body: { otherContacts: [] } }], recorded)));
  });

  it.effect('maps 410 and 400 EXPIRED_SYNC_TOKEN to SyncTokenExpiredError', () =>
    Effect.gen(function* () {
      const client = yield* GooglePeopleClient;
      const gone = yield* client
        .listConnections({ accountId: 'acc', syncToken: 'old' })
        .pipe(Effect.flip);
      expect(gone._tag).toBe('SyncTokenExpiredError');
      const expired = yield* client
        .listOtherContacts({ accountId: 'acc', syncToken: 'old' })
        .pipe(Effect.flip);
      expect(expired._tag).toBe('SyncTokenExpiredError');
      const other = yield* client.listConnections({ accountId: 'acc' }).pipe(Effect.flip);
      expect(other._tag).toBe('GoogleApiError');
    }).pipe(
      Effect.provide(
        clientLayer(
          [
            { status: 410 },
            {
              body: {
                error: { details: [{ reason: 'EXPIRED_SYNC_TOKEN' }], status: 'INVALID_ARGUMENT' },
              },
              status: 400,
            },
            { body: { error: { message: 'bad personFields' } }, status: 400 },
          ],
          [],
        ),
      ),
    ),
  );

  it.effect('maps a scope-insufficient 403 to InsufficientScopeError', () =>
    Effect.gen(function* () {
      const client = yield* GooglePeopleClient;
      const error = yield* client.listConnections({ accountId: 'acc' }).pipe(Effect.flip);
      expect(error._tag).toBe('InsufficientScopeError');
    }).pipe(
      Effect.provide(
        clientLayer(
          [
            {
              body: { error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } },
              status: 403,
            },
          ],
          [],
        ),
      ),
    ),
  );
});
