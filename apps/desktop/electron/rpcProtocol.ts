import { duplexServerProtocol } from '@calendar/sync/rpcDuplex';
import { ipcMain, webContents } from 'electron';
import type { Layer } from 'effect';
import type { RpcSerialization, RpcServer } from 'effect/rpc';
import { makeClientPages } from './rpcClientPages.ts';

type FrameListener = (clientId: number, data: string | Uint8Array) => void;
type DisconnectListener = (clientId: number) => void;

const frameListeners = new Set<FrameListener>();
const disconnectListeners = new Set<DisconnectListener>();

const seen = makeClientPages((clientId) => {
  for (const listener of disconnectListeners) {
    listener(clientId);
  }
});

ipcMain.on('rpc', (event, data: string | Uint8Array) => {
  const sender = event.sender;
  const clientId = sender.id;
  seen({
    id: clientId,
    onDestroyed: (listener) => {
      sender.once('destroyed', listener);
    },
    onNewDocument: (listener) => {
      sender.on('did-start-navigation', (details) => {
        // A hash change (the Settings window's panes) keeps the document.
        if (details.isMainFrame && !details.isSameDocument) {
          listener();
        }
      });
    },
  });
  for (const listener of frameListeners) {
    listener(clientId, data);
  }
});

/**
 * The AppBackend rpc protocol over Electron IPC: each renderer WebContents
 * is a client (id = webContents.id); frames travel on the 'rpc' channel.
 * A page that reloads leaves as a client before its new document joins
 * (rpcClientPages.ts).
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
