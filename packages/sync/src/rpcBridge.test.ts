import { Account, AppBackendRpcs, BackendError, type BackendHandlers } from '@calendar/core';
import { makeInvalidationBus } from '@calendar/db';
import { expect, it } from '@effect/vitest';
import { Effect, Fiber, Layer, Option, Stream } from 'effect';
import { RpcClient, RpcSerialization, RpcServer } from 'effect/unstable/rpc';
import { describe } from 'vitest';
import { makeAppBackendLayer } from './backendHandlers.ts';
import { duplexClientProtocol, duplexServerProtocol, type RpcFrame } from './rpcDuplex.ts';

const account = new Account({
  createdAt: 1,
  email: 'nik@example.com',
  id: 'acc-1',
  status: 'ok',
});

/** In-memory frame pair connecting the client and server protocols. */
const makeFramePair = () => {
  let toServer: ((clientId: number, data: RpcFrame) => void) | undefined;
  let toClient: ((data: RpcFrame) => void) | undefined;
  return {
    client: {
      onFrame: (listener: (data: RpcFrame) => void) => {
        toClient = listener;
      },
      send: (data: RpcFrame) => toServer?.(1, data),
    },
    server: {
      onDisconnect: () => {},
      onFrame: (listener: (clientId: number, data: RpcFrame) => void) => {
        toServer = listener;
      },
      send: (_clientId: number, data: RpcFrame) => toClient?.(data),
    },
  };
};

const notStubbed = () => Effect.fail(new Error('not stubbed')) as Effect.Effect<never, unknown>;

const stubHandlers: BackendHandlers = {
  addAccount: notStubbed,
  createEvent: notStubbed,
  deleteEvent: () => Effect.void,
  getEventsInRange: () => Effect.succeed([]),
  listAccounts: () => Effect.succeed([account]),
  listCalendars: () => Effect.succeed([]),
  removeAccount: () => Effect.void,
  setCalendarVisible: () => Effect.void,
  syncNow: notStubbed,
  updateEvent: () => Effect.void,
};

const makeHarness = () => {
  const bus = makeInvalidationBus();
  const pair = makeFramePair();
  const serverLayer = RpcServer.layer(AppBackendRpcs, {
    disableFatalDefects: true,
  }).pipe(
    Layer.provide(
      makeAppBackendLayer({
        handlers: stubHandlers,
        subscribeInvalidations: bus.subscribe,
      }),
    ),
    Layer.provide(duplexServerProtocol(pair.server)),
    Layer.provide(RpcSerialization.layerNdjson),
  );
  const clientLayer = duplexClientProtocol(pair.client).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
  );
  return { bus, clientLayer, serverLayer };
};

describe('AppBackend rpc bridge', () => {
  it.effect('round-trips a request/response through serialization', () => {
    const { clientLayer, serverLayer } = makeHarness();
    return Effect.gen(function* () {
      const client = yield* RpcClient.make(AppBackendRpcs);
      const accounts = yield* client.listAccounts(undefined);
      expect(accounts).toHaveLength(1);
      // Schema round-trip reconstructs the class instance.
      expect(accounts[0]).toBeInstanceOf(Account);
      expect(accounts[0]!.email).toBe('nik@example.com');
    }).pipe(Effect.provide(clientLayer), Effect.provide(serverLayer));
  });

  it.effect('normalizes handler failures to typed BackendError', () => {
    const { clientLayer, serverLayer } = makeHarness();
    return Effect.gen(function* () {
      const client = yield* RpcClient.make(AppBackendRpcs);
      const error = yield* client.syncNow(undefined).pipe(Effect.flip);
      expect(error).toBeInstanceOf(BackendError);
      expect((error as BackendError).message).toContain('not stubbed');
    }).pipe(Effect.provide(clientLayer), Effect.provide(serverLayer));
  });

  it.effect('streams invalidation keys to the client', () => {
    const { bus, clientLayer, serverLayer } = makeHarness();
    return Effect.gen(function* () {
      const client = yield* RpcClient.make(AppBackendRpcs);
      const firstBatch = yield* Effect.forkChild(Stream.runHead(client.invalidations(undefined)));
      // Give the stream subscription a beat to reach the server.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
      bus.publish(['accounts', 'events:cal-1']);
      const result = yield* Fiber.join(firstBatch);
      expect(Option.getOrThrow(result)).toEqual(['accounts', 'events:cal-1']);
    }).pipe(Effect.provide(clientLayer), Effect.provide(serverLayer));
  });
});
