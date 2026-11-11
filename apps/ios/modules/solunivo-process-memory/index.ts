import { requireNativeModule } from 'expo';

/**
 * The process's memory in bytes, as iOS counts it against the app:
 * `footprint` is what the app holds (the number the system's limit is
 * about), `available` what it may still take before iOS ends it (0 where
 * the system does not say: the simulator), `physical` the device's RAM.
 */
export interface ProcessMemory {
  readonly available: number;
  readonly footprint: number;
  readonly physical: number;
}

interface SolunivoProcessMemoryNative {
  /**
   * Keeps the screen from locking while a measurement runs, and lets it
   * lock again: a locked iPhone suspends the app, and the time it was
   * away would be counted as the model's.
   */
  readonly keepAwake: (on: boolean) => void;
  readonly read: () => ProcessMemory;
}

/**
 * Loaded lazily: `requireNativeModule` throws on a binary built before this
 * module existed, and a static call at import time would take the whole
 * app down with it.
 */
export const loadProcessMemoryModule = (): SolunivoProcessMemoryNative | undefined => {
  try {
    return requireNativeModule<SolunivoProcessMemoryNative>('SolunivoProcessMemory');
  } catch {
    return undefined;
  }
};
