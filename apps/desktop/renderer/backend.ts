import type { AgentPolicy } from '@calendar/agent/policy';
import type { AgentRequestView, AgentsState, AgentView } from '@calendar/agent/view';
import { AppBackendRpcs, type BackendClient } from '@calendar/core';
import { duplexClientProtocol } from '@calendar/sync/rpcDuplex';
import { Context, Effect, Fiber, Layer, ManagedRuntime, Stream } from 'effect';
import { RpcClient, RpcSerialization } from 'effect/rpc';
import type { RpcClientError } from 'effect/rpc/RpcClientError';
import type { SettingsPaneId } from './settingsPanes.ts';

export interface PrivacyState {
  readonly mode: 'hidden' | 'visible';
  readonly visibleUntil?: number;
}

/** The watched settings file, as the main process reports it. */
export interface SettingsFileStatus {
  readonly error?: string;
  readonly exists: boolean;
  readonly lastAppliedAt?: number;
  readonly path: string;
}

declare global {
  interface Window {
    calendarBridge: {
      agentsCreate: (name: string) => Promise<{ agent: AgentView; token: string }>;
      agentsDecide: (
        requestId: string,
        decision: 'approve' | 'deny',
      ) => Promise<AgentRequestView | null>;
      agentsRemove: (id: string) => Promise<void>;
      agentsRotate: (id: string) => Promise<{ token: string } | null>;
      agentsState: () => Promise<AgentsState>;
      agentsUpdate: (
        id: string,
        changes: { name?: string; policy?: AgentPolicy },
      ) => Promise<AgentView | undefined>;
      appleCalendarStatus: () => Promise<string>;
      /** Stops a Google sign-in waiting on the browser: it fails as cancelled. */
      authCancel: () => Promise<void>;
      contactsStatus: () => Promise<string>;
      logError?: (text: string) => void;
      modelGenerate: (schema: unknown, prompt: string) => Promise<{ json: string }>;
      modelPrepareSpeech: (locale: string) => Promise<{ denied?: boolean; prepared?: boolean }>;
      modelRecognizeText: (imageBase64: string) => Promise<{ text: string }>;
      modelStatus: () => Promise<{ detail?: string; status: string }>;
      modelTranscribe: (
        audioBase64: string,
        locale: string,
      ) => Promise<{ segments: ReadonlyArray<{ text: string }> }>;
      onAgentsChanged: (listener: () => void) => () => void;
      /** Clicked event reminders, the one waiting first; decode with `parseNotificationTarget`. */
      onNotificationOpen: (listener: (target: unknown) => void) => () => void;
      onPrivacyChanged: (listener: (state: PrivacyState) => void) => () => void;
      onRpcMessage: (listener: (data: string | Uint8Array) => void) => () => void;
      onSettingsFileChanged: (listener: (status: SettingsFileStatus) => void) => () => void;
      /** Opens the settings window (or focuses it), on `pane` when given. */
      openSettings: (pane?: SettingsPaneId) => Promise<void>;
      privacyGet: () => Promise<PrivacyState>;
      privacySet: (choice: 'hidden' | 'pause10m' | 'visible') => Promise<PrivacyState>;
      remindersStatus: () => Promise<string>;
      rpcSend: (data: string | Uint8Array) => void;
      settingsFileCreate: () => Promise<SettingsFileStatus>;
      settingsFileOpen: () => Promise<{ canceled: true } | { path: string; text: string }>;
      settingsFileSave: (text: string) => Promise<{ canceled: true } | { path: string }>;
      settingsFileStatus: () => Promise<SettingsFileStatus>;
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
