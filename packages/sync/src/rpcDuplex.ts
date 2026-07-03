import { Effect, Layer } from 'effect';
import { Queue } from 'effect';
import { RpcClient, RpcSerialization, RpcServer } from 'effect/unstable/rpc';
import type { FromClientEncoded, FromServerEncoded } from 'effect/unstable/rpc/RpcMessage';

export type RpcFrame = string | Uint8Array;

/** Server side of a frame transport (e.g. Electron ipcMain). */
export interface ServerFrameTransport {
  readonly onDisconnect: (listener: (clientId: number) => void) => void;
  readonly onFrame: (listener: (clientId: number, data: RpcFrame) => void) => void;
  readonly send: (clientId: number, data: RpcFrame) => void;
}

/** Client side of a frame transport (e.g. the preload bridge). */
export interface ClientFrameTransport {
  readonly onFrame: (listener: (data: RpcFrame) => void) => void;
  readonly send: (data: RpcFrame) => void;
}

/**
 * RpcServer.Protocol over any frame transport that preserves message
 * boundaries. One serialization parser per client keeps framing state
 * isolated.
 */
export const duplexServerProtocol = (
  transport: ServerFrameTransport,
): Layer.Layer<RpcServer.Protocol, never, RpcSerialization.RpcSerialization> =>
  Layer.effect(RpcServer.Protocol)(
    RpcServer.Protocol.make((writeRequest) =>
      Effect.gen(function* () {
        const serialization = yield* RpcSerialization.RpcSerialization;
        const disconnects = yield* Queue.make<number>();
        const parsers = new Map<number, ReturnType<typeof serialization.makeUnsafe>>();
        const clients = new Set<number>();

        const parserFor = (clientId: number) => {
          let parser = parsers.get(clientId);
          if (!parser) {
            parser = serialization.makeUnsafe();
            parsers.set(clientId, parser);
          }
          return parser;
        };

        transport.onFrame((clientId, data) => {
          clients.add(clientId);
          for (const message of parserFor(clientId).decode(data)) {
            Effect.runFork(writeRequest(clientId, message as FromClientEncoded));
          }
        });
        transport.onDisconnect((clientId) => {
          clients.delete(clientId);
          parsers.delete(clientId);
          Queue.offerUnsafe(disconnects, clientId);
        });

        return {
          clientIds: Effect.sync(() => new Set(clients)),
          disconnects,
          end: (_clientId) => Effect.void,
          initialMessage: Effect.succeedNone,
          send: (clientId, response) =>
            Effect.sync(() => {
              const encoded = parserFor(clientId).encode(response);
              if (encoded !== undefined) {
                transport.send(clientId, encoded);
              }
            }),
          supportsAck: true,
          supportsSpanPropagation: false,
          supportsTransferables: false,
        };
      }),
    ),
  );

/**
 * RpcClient.Protocol over a frame transport. Responses carrying a requestId
 * route to the requesting client; everything else broadcasts.
 */
export const duplexClientProtocol = (
  transport: ClientFrameTransport,
): Layer.Layer<RpcClient.Protocol, never, RpcSerialization.RpcSerialization> =>
  Layer.effect(RpcClient.Protocol)(
    RpcClient.Protocol.make((writeResponse, clientIds) =>
      Effect.gen(function* () {
        const serialization = yield* RpcSerialization.RpcSerialization;
        const parser = serialization.makeUnsafe();
        const requestClientMap = new Map<string, number>();

        transport.onFrame((data) => {
          const responses = parser.decode(data) as Array<FromServerEncoded>;
          for (const response of responses) {
            if ('requestId' in response) {
              const clientId = requestClientMap.get(String(response.requestId));
              if (response._tag === 'Exit') {
                requestClientMap.delete(String(response.requestId));
              }
              if (clientId !== undefined) {
                Effect.runFork(writeResponse(clientId, response));
                continue;
              }
            }
            for (const clientId of clientIds) {
              Effect.runFork(writeResponse(clientId, response));
            }
          }
        });

        return {
          send: (clientId, request) =>
            Effect.sync(() => {
              if (request._tag === 'Request') {
                requestClientMap.set(String(request.id), clientId);
              }
              const encoded = parser.encode(request);
              if (encoded !== undefined) {
                transport.send(encoded);
              }
            }),
          supportsAck: true,
          supportsTransferables: false,
        };
      }),
    ),
  );
