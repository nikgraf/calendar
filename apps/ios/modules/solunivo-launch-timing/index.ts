import { requireNativeModule } from 'expo';

/**
 * The launches the native side saw start, in milliseconds since 1970: this
 * one once its window's scene connected (`start`), and the earlier ones
 * closed before their JavaScript ran, oldest first (`unfinished`).
 */
export interface TakenLaunches {
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
