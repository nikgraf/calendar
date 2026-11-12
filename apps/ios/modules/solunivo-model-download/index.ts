import { requireNativeModule } from 'expo';

/** What the network is now: there at all, paid for by the byte (mobile data, a hotspot), in Low Data Mode. */
export interface NetworkPath {
  readonly constrained: boolean;
  readonly expensive: boolean;
  readonly satisfied: boolean;
}

/** `wifi`: no expensive network and no Low Data Mode, iOS holds the transfer until there is one. `any`: whatever is there. */
export type DownloadNetwork = 'any' | 'wifi';

export type CurrentTransfer =
  | { readonly state: 'none' }
  | {
      readonly expected: number;
      readonly network: DownloadNetwork;
      readonly received: number;
      readonly state: 'running' | 'suspended';
    };

export interface DownloadEvents {
  readonly onFail: (event: { readonly message: string; readonly status: number }) => void;
  readonly onFinish: (event: { readonly path: string }) => void;
  readonly onPath: (event: NetworkPath) => void;
  readonly onProgress: (event: { readonly expected: number; readonly received: number }) => void;
}

export interface SolunivoModelDownloadNative {
  readonly addListener: <Name extends keyof DownloadEvents>(
    name: Name,
    listener: DownloadEvents[Name],
  ) => { readonly remove: () => void };
  /** Stops the transfer and forgets what it fetched. */
  readonly cancel: (destination: string) => Promise<void>;
  /** The transfer under way, if any, also one an earlier launch started. */
  readonly current: () => Promise<CurrentTransfer>;
  readonly path: () => NetworkPath;
  /**
   * Starts fetching `url` into `destination` (a file URL), on a transfer's
   * resume data where an earlier one left some; nothing when a transfer is
   * running already.
   */
  readonly start: (
    url: string,
    destination: string,
    network: DownloadNetwork,
  ) => Promise<{ readonly network: DownloadNetwork; readonly started: boolean }>;
  /** Moves the running transfer to the other network rule, keeping what it fetched. */
  readonly useNetwork: (network: DownloadNetwork) => Promise<boolean>;
}

/**
 * Loaded lazily: `requireNativeModule` throws on a binary built before this
 * module existed (an OTA update on an older TestFlight build), and a static
 * call at import time would take the whole app down with it.
 */
export const loadModelDownloadModule = (): SolunivoModelDownloadNative | undefined => {
  try {
    return requireNativeModule<SolunivoModelDownloadNative>('SolunivoModelDownload');
  } catch {
    return undefined;
  }
};
