import { requireNativeModule } from 'expo-modules-core';

interface SolunivoOcrNative {
  readonly invoke: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Loaded lazily: `requireNativeModule` throws on a binary built before this
 * module existed (an older dev client), and a static call at import time
 * would take the whole app down with it.
 */
export const loadOcrModule = (): SolunivoOcrNative | undefined => {
  try {
    return requireNativeModule<SolunivoOcrNative>('SolunivoOcr');
  } catch {
    return undefined;
  }
};
