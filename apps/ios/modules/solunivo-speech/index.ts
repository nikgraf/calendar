import { requireNativeModule } from 'expo';

/** A recogniser's words so far for one phrase, whenever they change. */
export interface SpeechWordsEvent {
  readonly session: number;
  readonly source: 'accurate' | 'quick';
  readonly text: string;
}

export interface SolunivoSpeechNative {
  readonly addListener: (
    name: 'onWords',
    listener: (event: SpeechWordsEvent) => void,
  ) => { readonly remove: () => void };
  /** Drops the phrase and closes the microphone; nothing when `session` is not the current one. */
  readonly cancel: (session: number) => Promise<void>;
  /**
   * Closes the microphone and reads the phrase whole. Null when `session`
   * is not the current one (dropped, or replaced by a newer start).
   */
  readonly finish: (session: number) => Promise<{
    readonly segments: ReadonlyArray<{
      readonly alternatives: ReadonlyArray<string>;
      readonly text: string;
    }>;
  } | null>;
  /** Installs the locale's speech assets; rejects with "unsupported: …" where it never will. */
  readonly prepare: (locale: string) => Promise<void>;
  /** Asks for the microphone if iOS has not yet; whether it may be used. */
  readonly requestMicrophone: () => Promise<boolean>;
  /** Opens the microphone for a phrase; a newer start replaces it. */
  readonly start: (session: number, locale: string, voiceProcessing: boolean) => Promise<void>;
}

/**
 * Loaded lazily: `requireNativeModule` throws on a binary built before this
 * module existed (an OTA update on an older TestFlight build), and a static
 * call at import time would take the whole app down with it.
 */
export const loadSpeechModule = (): SolunivoSpeechNative | undefined => {
  try {
    return requireNativeModule<SolunivoSpeechNative>('SolunivoSpeech');
  } catch {
    return undefined;
  }
};
