import { requireNativeModule } from 'expo-modules-core';

interface SolunivoContactsNative {
  readonly addListener: (
    event: 'contactsChanged',
    listener: () => void,
  ) => { readonly remove: () => void };
  readonly invoke: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Loaded lazily: `requireNativeModule` throws on a binary built before this
 * module existed (an older dev client), and a static call at import time
 * would take the whole app down with it.
 */
export const loadContactsModule = (): SolunivoContactsNative | undefined => {
  try {
    return requireNativeModule<SolunivoContactsNative>('SolunivoContacts');
  } catch {
    return undefined;
  }
};
