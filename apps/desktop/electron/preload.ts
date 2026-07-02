import { contextBridge } from 'electron';

// Placeholder bridge — becomes the effect rpc MessagePort transport in M3.
contextBridge.exposeInMainWorld('calendarBridge', {
  ping: () => 'pong',
});
