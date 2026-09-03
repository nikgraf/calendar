import { AppBackendRpcs, type BackendClient } from '@calendar/core';
import { duplexClientProtocol } from '@calendar/sync/rpcDuplex';
import { Context, Effect, Fiber, Layer, ManagedRuntime, Stream } from 'effect';
import { RpcClient, RpcSerialization } from 'effect/unstable/rpc';
import type { RpcClientError } from 'effect/unstable/rpc/RpcClientError';

export interface PrivacyState {
  readonly mode: 'hidden' | 'visible';
  readonly visibleUntil?: number;
}

declare global {
  interface Window {
    calendarBridge: {
      logError?: (text: string) => void;
      modelGenerate: (schema: unknown, prompt: string) => Promise<{ json: string }>;
      modelPrepareSpeech: (locale: string) => Promise<{ denied?: boolean; prepared?: boolean }>;
      modelStatus: () => Promise<{ detail?: string; status: string }>;
      modelTranscribe: (
        audioBase64: string,
        locale: string,
      ) => Promise<{ segments: ReadonlyArray<{ text: string }> }>;
      onPrivacyChanged: (listener: (state: PrivacyState) => void) => () => void;
      onRpcMessage: (listener: (data: string | Uint8Array) => void) => () => void;
      privacyGet: () => Promise<PrivacyState>;
      privacySet: (choice: 'hidden' | 'pause10m' | 'visible') => Promise<PrivacyState>;
      remindersListLists: () => Promise<ReadonlyArray<{ id: string; title: string }>>;
      remindersRequestAccess: () => Promise<boolean>;
      remindersStatus: () => Promise<string>;
      rpcSend: (data: string | Uint8Array) => void;
    };
  }
}

const rpcClientProtocol = duplexClientProtocol({
  onFrame: (listener) => {
    window.calendarBridge.onRpcMessage(listener);
  },
  send: (data) => {
    window.calendarBridge.rpcSend(data);
  },
});

class RpcBackend extends Context.Service<
  RpcBackend,
  RpcClient.FromGroup<typeof AppBackendRpcs, RpcClientError>
>()('desktop/RpcBackend') {}

const runtime = ManagedRuntime.make(
  Layer.effect(RpcBackend)(RpcClient.make(AppBackendRpcs)).pipe(
    Layer.provide(rpcClientProtocol),
    Layer.provide(RpcSerialization.layerNdjson),
  ),
);

const rpcClient = await runtime.runPromise(
  Effect.gen(function* () {
    return yield* RpcBackend;
  }),
);

/** The request/response surface the atoms consume. */
export const backend: BackendClient = rpcClient;

/** Subscribes to the typed server-push invalidation stream. */
export const subscribeInvalidations = (
  listener: (keys: ReadonlyArray<unknown>) => void,
): (() => void) => {
  const fiber = runtime.runFork(
    Stream.runForEach(rpcClient.invalidations(), (keys) => Effect.sync(() => listener(keys))),
  );
  return () => {
    void runtime.runFork(Fiber.interrupt(fiber));
  };
};
