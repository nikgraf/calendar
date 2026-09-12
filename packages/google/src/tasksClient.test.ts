import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http';
import { describe } from 'vitest';
import { TokenManager, type TokenManagerShape } from './oauth/tokenManager.ts';
import { GoogleTasksClient } from './tasksClient.ts';

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
): Layer.Layer<GoogleTasksClient> =>
  GoogleTasksClient.layer.pipe(
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
                headers: { 'content-type': 'application/json' },
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

const bodyOf = (request: HttpClientRequest.HttpClientRequest): unknown => {
  const body = request.body as { readonly body?: Uint8Array };
  return body.body ? JSON.parse(new TextDecoder().decode(body.body)) : undefined;
};

describe('GoogleTasksClient', () => {
  it.effect('lists tasks with completed, hidden and deleted included, plus the watermark', () => {
    const recorded: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const client = yield* GoogleTasksClient;
      const page = yield* client.listTasks({
        accountId: 'acc-1',
        params: { updatedMin: '2026-08-20T00:00:00.000Z' },
        taskListId: 'list-1',
      });
      expect(page.items).toEqual([{ id: 't1', title: 'Pay rent' }]);
      const query = params(recorded[0]!);
      expect(recorded[0]!.url).toContain('/lists/list-1/tasks');
      expect(query.get('showCompleted')).toBe('true');
      expect(query.get('showDeleted')).toBe('true');
      expect(query.get('showHidden')).toBe('true');
      expect(query.get('updatedMin')).toBe('2026-08-20T00:00:00.000Z');
    }).pipe(
      Effect.provide(
        clientLayer([{ body: { items: [{ id: 't1', title: 'Pay rent' }] } }], recorded),
      ),
    );
  });

  it.effect('omits updatedMin on a full pass and lists task lists', () => {
    const recorded: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const client = yield* GoogleTasksClient;
      yield* client.listTasks({ accountId: 'acc-1', params: {}, taskListId: 'list-1' });
      expect(params(recorded[0]!).has('updatedMin')).toBe(false);
      const lists = yield* client.listTaskLists({ accountId: 'acc-1' });
      expect(lists.items?.[0]?.id).toBe('list-1');
      expect(recorded[1]!.url).toContain('/users/@me/lists');
    }).pipe(
      Effect.provide(
        clientLayer([{ body: { items: [] } }, { body: { items: [{ id: 'list-1' }] } }], recorded),
      ),
    );
  });

  it.effect('un-completing clears the completion timestamp explicitly', () => {
    const recorded: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const client = yield* GoogleTasksClient;
      yield* client.patchTask({
        accountId: 'acc-1',
        changes: { status: 'needsAction' },
        taskId: 't1',
        taskListId: 'list-1',
      });
      expect(recorded[0]!.method).toBe('PATCH');
      expect(bodyOf(recorded[0]!)).toEqual({ completed: null, status: 'needsAction' });
      yield* client.patchTask({
        accountId: 'acc-1',
        changes: { due: null, title: 'Renamed' },
        taskId: 't1',
        taskListId: 'list-1',
      });
      expect(bodyOf(recorded[1]!)).toEqual({ due: null, title: 'Renamed' });
    }).pipe(
      Effect.provide(
        clientLayer(
          [{ body: { id: 't1', status: 'needsAction' } }, { body: { id: 't1' } }],
          recorded,
        ),
      ),
    );
  });

  it.effect('posts an insert and maps a 404 on delete', () => {
    const recorded: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const client = yield* GoogleTasksClient;
      const inserted = yield* client.insertTask({
        accountId: 'acc-1',
        task: { due: '2026-08-30T00:00:00.000Z', title: 'New' },
        taskListId: 'list-1',
      });
      expect(inserted.id).toBe('server-1');
      expect(recorded[0]!.method).toBe('POST');
      expect(bodyOf(recorded[0]!)).toEqual({ due: '2026-08-30T00:00:00.000Z', title: 'New' });

      const gone = yield* Effect.flip(
        client.deleteTask({ accountId: 'acc-1', taskId: 't-missing', taskListId: 'list-1' }),
      );
      expect(gone._tag).toBe('NotFoundError');
      const ok = yield* client.deleteTask({
        accountId: 'acc-1',
        taskId: 't1',
        taskListId: 'list-1',
      });
      expect(ok).toBeUndefined();
    }).pipe(
      Effect.provide(
        clientLayer(
          [{ body: { id: 'server-1', title: 'New' } }, { status: 404 }, { status: 204 }],
          recorded,
        ),
      ),
    );
  });
});
