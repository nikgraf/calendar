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
  /** Brings Calendar.app forward (false under the e2e fixture, which opens nothing). */
  appleCalendarOpen: () => ipcRenderer.invoke('appleCalendar:open'),
  appleCalendarStatus: () => ipcRenderer.invoke('appleCalendar:status'),
  /** Stops a Google sign-in waiting on the browser (Accounts › Cancel). */
  authCancel: () => ipcRenderer.invoke('auth:cancel'),
  contactsStatus: () => ipcRenderer.invoke('contacts:status'),
  logError: (text: string) => ipcRenderer.send('renderer-error', text),
  modelGenerate: (schema: unknown, prompt: string) =>
    ipcRenderer.invoke('model:generate', schema, prompt),
  /** The Swift helper's own status: what dictation and text recognition depend on. */
  modelHelperStatus: () => ipcRenderer.invoke('model:helper-status'),
  modelInfo: () => ipcRenderer.invoke('model:info'),
  modelPrepareSpeech: (locale: string) => ipcRenderer.invoke('model:prepare-speech', locale),
  /** The model provider (Settings › General): the view, changes, and a probe of unsaved settings. */
  modelProviderGet: () => ipcRenderer.invoke('model:provider-get'),
  modelProviderSet: (changes: unknown) => ipcRenderer.invoke('model:provider-set', changes),
  modelProviderTest: (candidate: unknown) => ipcRenderer.invoke('model:provider-test', candidate),
  modelRecognizeText: (imageBase64: string) =>
    ipcRenderer.invoke('model:recognize-text', imageBase64),
  modelStatus: () => ipcRenderer.invoke('model:status'),
  modelTranscribe: (audioBase64: string, locale: string) =>
    ipcRenderer.invoke('model:transcribe', audioBase64, locale),
  onAgentsChanged: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on('agents:changed', wrapped);
    return () => ipcRenderer.off('agents:changed', wrapped);
  },
  onModelProviderChanged: (listener: (view: unknown) => void) => {
    const wrapped = (_event: unknown, view: unknown) => listener(view);
    ipcRenderer.on('model:providerChanged', wrapped);
    return () => ipcRenderer.off('model:providerChanged', wrapped);
  },
  /**
   * Event reminders clicked in Notification Center: the one waiting at
   * subscription (it may have opened this window), then one per click.
   */
  onNotificationOpen: (listener: (target: unknown) => void) => {
    const take = () => {
      void ipcRenderer.invoke('notifications:take').then((target: unknown) => {
        if (target) {
          listener(target);
        }
      });
    };
    ipcRenderer.on('notifications:open', take);
    take();
    return () => ipcRenderer.off('notifications:open', take);
  },
  /**
   * True while a screen capture runs that leaves the windows out
   * (captureHint.ts): the state at subscription — this window may open
   * mid-capture — then every change.
   */
  onPrivacyCapture: (listener: (capturing: boolean) => void) => {
    const wrapped = (_event: unknown, capturing: boolean) => listener(capturing === true);
    ipcRenderer.on('privacy:capture', wrapped);
    void ipcRenderer.invoke('privacy:capture-state').then(
      (capturing: unknown) => {
        if (capturing === true) {
          listener(true);
        }
      },
      () => undefined,
    );
    return () => ipcRenderer.off('privacy:capture', wrapped);
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
  openSettings: (pane?: string) => ipcRenderer.invoke('settings:open', pane),
  privacyGet: () => ipcRenderer.invoke('privacy:get'),
  privacySet: (choice: string) => ipcRenderer.invoke('privacy:set', choice),
  remindersStatus: () => ipcRenderer.invoke('reminders:status'),
  rpcSend: (data: string | Uint8Array) => ipcRenderer.send('rpc', data),
  settingsFileCreate: () => ipcRenderer.invoke('settingsFile:create'),
  settingsFileOpen: () => ipcRenderer.invoke('settingsFile:open'),
  settingsFileSave: (text: string) => ipcRenderer.invoke('settingsFile:save', text),
  settingsFileStatus: () => ipcRenderer.invoke('settingsFile:status'),
});

// This document is a new rpc client: sent before any of its rpc frames, so
// main ends a reloaded page's old client first (electron/rpcClientPages.ts).
ipcRenderer.send('rpc:document');
