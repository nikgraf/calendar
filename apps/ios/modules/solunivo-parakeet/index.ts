import { requireNativeModule } from 'expo';

/** The Parakeet models the Speech Spike page can load (FluidAudio's names). */
export type ParakeetVersion = 'ultra' | 'v3';

/** One file, as Parakeet heard it. */
export interface ParakeetHeard {
  readonly audioSeconds: number;
  /** Decoding the file, the model and the vocabulary's rescoring, together. */
  readonly ms: number;
  /** Before the vocabulary's rescoring. */
  readonly raw: string;
  readonly replacements: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly rescoreMs: number;
  readonly text: string;
}

export interface SolunivoParakeetNative {
  readonly addListener: (
    event: 'onProgress',
    listener: (progress: { readonly fraction: number; readonly phase: string }) => void,
  ) => { readonly remove: () => void };
  /** Fetches the model the first time, then loads it; an empty vocabulary loads no spotter. */
  readonly load: (
    version: ParakeetVersion,
    vocabulary: ReadonlyArray<string>,
  ) => Promise<{ readonly loadMs: number }>;
  readonly release: () => Promise<void>;
  /** A file URI (`file:///…`) of audio AVAudioFile reads. */
  readonly transcribe: (uri: string) => Promise<ParakeetHeard>;
}

/**
 * Loaded lazily: `requireNativeModule` throws on a binary built before this
 * module existed, and a static call at import time would take the whole
 * app down with it.
 */
export const loadParakeetModule = (): SolunivoParakeetNative | undefined => {
  try {
    return requireNativeModule<SolunivoParakeetNative>('SolunivoParakeet');
  } catch {
    return undefined;
  }
};
