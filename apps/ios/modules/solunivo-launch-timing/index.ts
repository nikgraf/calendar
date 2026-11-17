import { requireNativeModule } from 'expo';

/**
 * The launches the native side saw start, in milliseconds since 1970: this
 * one once its window's scene connected (`start`), and the earlier ones
 * closed before their JavaScript ran, oldest first (`unfinished`). A
 * launch that starts at its scene, since its process ran before (prewarmed,
 * woken in the background, or stalled before its window), carries how long
 * that was (`before`, in milliseconds).
 */
export interface TakenLaunches {
  readonly before?: number;
  readonly start?: number;
  readonly unfinished?: ReadonlyArray<number>;
}

interface SolunivoLaunchTimingNative {
  /**
   * The launches for this process's first reader; empty for a later one (a
   * reload runs the bundle again in the same process).
   */
  readonly take: () => TakenLaunches;
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
