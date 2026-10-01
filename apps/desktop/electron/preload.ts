import { contextBridge, ipcRenderer } from 'electron';

// The renderer's only door into the main process: a duplex frame channel
// carrying the AppBackend rpc protocol (see packages/core/src/backend.ts).
contextBridge.exposeInMainWorld('calendarBridge', {
  agentsCreate: (name: string) => ipcRenderer.invoke('agents:create', name),
  agentsDecide: (requestId: string, decision: string) =>
    ipcRenderer.invoke('agents:decide', requestId, decision),
  agentsRemove: (id: string) => ipcRenderer.invoke('agents:remove', id),
  agentsRotate: (id: string) => ipcRenderer.invoke('agents:rotate', id),
  agentsState: () => ipcRenderer.invoke('agents:state'),
  agentsUpdate: (id: string, changes: unknown) => ipcRenderer.invoke('agents:update', id, changes),
  appleCalendarStatus: () => ipcRenderer.invoke('appleCalendar:status'),
  contactsStatus: () => ipcRenderer.invoke('contacts:status'),
  logError: (text: string) => ipcRenderer.send('renderer-error', text),
  modelGenerate: (schema: unknown, prompt: string) =>
    ipcRenderer.invoke('model:generate', schema, prompt),
  modelPrepareSpeech: (locale: string) => ipcRenderer.invoke('model:prepare-speech', locale),
  modelStatus: () => ipcRenderer.invoke('model:status'),
  modelTranscribe: (audioBase64: string, locale: string) =>
    ipcRenderer.invoke('model:transcribe', audioBase64, locale),
  onAgentsChanged: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on('agents:changed', wrapped);
    return () => ipcRenderer.off('agents:changed', wrapped);
  },
  onPrivacyChanged: (listener: (state: unknown) => void) => {
    const wrapped = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on('privacy:changed', wrapped);
    return () => ipcRenderer.off('privacy:changed', wrapped);
  },
  onRpcMessage: (listener: (data: string | Uint8Array) => void) => {
    const wrapped = (_event: unknown, data: string | Uint8Array) => listener(data);
    ipcRenderer.on('rpc', wrapped);
    return () => ipcRenderer.off('rpc', wrapped);
  },
  onSettingsFileChanged: (listener: (status: unknown) => void) => {
    const wrapped = (_event: unknown, status: unknown) => listener(status);
    ipcRenderer.on('settingsFile:changed', wrapped);
    return () => ipcRenderer.off('settingsFile:changed', wrapped);
  },
  privacyGet: () => ipcRenderer.invoke('privacy:get'),
  privacySet: (choice: string) => ipcRenderer.invoke('privacy:set', choice),
  remindersStatus: () => ipcRenderer.invoke('reminders:status'),
  rpcSend: (data: string | Uint8Array) => ipcRenderer.send('rpc', data),
  settingsFileCreate: () => ipcRenderer.invoke('settingsFile:create'),
  settingsFileOpen: () => ipcRenderer.invoke('settingsFile:open'),
  settingsFileSave: (text: string) => ipcRenderer.invoke('settingsFile:save', text),
  settingsFileStatus: () => ipcRenderer.invoke('settingsFile:status'),
});
