import { requireNativeModule } from 'expo';

/**
 * Foundation Models' availability as the module answers it: `available`,
 * or `unavailable` with the reason stringified the way the desktop helper
 * does it (`appleIntelligenceNotEnabled`, `deviceNotEligible`,
 * `modelNotReady`; `osTooOld` below iOS 26).
 */
export interface ModelAvailabilityReply {
  readonly reason?: string;
  readonly status: 'available' | 'unavailable';
}

interface SolunivoModelAvailabilityNative {
  readonly check: () => Promise<ModelAvailabilityReply>;
}

/**
 * Loaded lazily: `requireNativeModule` throws on a binary built before this
 * module existed (an older dev client or TestFlight build), and a static
 * call at import time would take the whole app down with it.
 */
export const loadModelAvailabilityModule = (): SolunivoModelAvailabilityNative | undefined => {
  try {
    return requireNativeModule<SolunivoModelAvailabilityNative>('SolunivoModelAvailability');
  } catch {
    return undefined;
  }
};
