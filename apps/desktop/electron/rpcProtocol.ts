import { duplexServerProtocol } from '@calendar/sync/rpcDuplex';
import { ipcMain, webContents } from 'electron';
import type { Layer } from 'effect';
import type { RpcSerialization, RpcServer } from 'effect/unstable/rpc';

type FrameListener = (clientId: number, data: string | Uint8Array) => void;
type DisconnectListener = (clientId: number) => void;

const frameListeners = new Set<FrameListener>();
const disconnectListeners = new Set<DisconnectListener>();
const knownClients = new Set<number>();

ipcMain.on('rpc', (event, data: string | Uint8Array) => {
  const clientId = event.sender.id;
  if (!knownClients.has(clientId)) {
    knownClients.add(clientId);
    event.sender.once('destroyed', () => {
      knownClients.delete(clientId);
      for (const listener of disconnectListeners) {
        listener(clientId);
      }
    });
  }
  for (const listener of frameListeners) {
    listener(clientId, data);
  }
});

/**
 * The AppBackend rpc protocol over Electron IPC: each renderer WebContents
 * is a client (id = webContents.id); frames travel on the 'rpc' channel.
 */
export const rpcServerProtocol: Layer.Layer<
  RpcServer.Protocol,
  never,
  RpcSerialization.RpcSerialization
> = duplexServerProtocol({
  onDisconnect: (listener) => {
    disconnectListeners.add(listener);
  },
  onFrame: (listener) => {
    frameListeners.add(listener);
  },
  send: (clientId, data) => {
    const target = webContents.fromId(clientId);
    if (target && !target.isDestroyed()) {
      target.send('rpc', data);
    }
  },
});
