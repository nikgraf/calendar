import { requireNativeModule } from 'expo';

/**
 * When this launch began, in milliseconds since 1970: the process's start,
 * or UIKit's launch call for a process iOS prewarmed (`from: 'launch'`).
 */
export interface LaunchStart {
  readonly from: 'launch' | 'process';
  readonly start: number;
}

interface SolunivoLaunchTimingNative {
  /**
   * The launch's start for its first reader in this process; null for a
   * later one (a reload runs the bundle again) and for a launch in the
   * background.
   */
  readonly take: () => LaunchStart | null;
}

/**
 * Loaded lazily: `requireNativeModule` throws on a binary built before this
 * module existed, and a static call at import time would take the whole
 * app down with it.
 */
export const loadLaunchTimingModule = (): SolunivoLaunchTimingNative | undefined => {
  try {
    return requireNativeModule<SolunivoLaunchTimingNative>('SolunivoLaunchTiming');
  } catch {
    return undefined;
  }
};
