import { makeBackendClient, type BackendTransport } from '@calendar/core';

declare global {
  interface Window {
    calendarBridge: BackendTransport;
  }
}

export const backend = makeBackendClient(window.calendarBridge);
