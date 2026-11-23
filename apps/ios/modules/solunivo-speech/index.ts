import { requireNativeModule } from 'expo';

/** A recogniser's words so far for one phrase, whenever they change. */
export interface SpeechWordsEvent {
  readonly session: number;
  readonly source: 'accurate' | 'quick';
  readonly text: string;
}

/** iOS's Mic Mode for the app, as the user picked it in Control Center. */
export type MicrophoneMode = 'standard' | 'voiceIsolation' | 'wideSpectrum';

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
    /** The phrase as the user's other language reads it; absent without one, and on a binary built before it. */
    readonly other?: string;
    readonly segments: ReadonlyArray<{
      readonly alternatives: ReadonlyArray<string>;
      readonly text: string;
    }>;
  } | null>;
  /**
   * A locale's language in English, the app's own ("German (Austria)"); the
   * id when it has no name. Absent on a binary built before it (a stale
   * local dev client: OTA updates never reach another fingerprint).
   */
  readonly languageName?: (locale: string) => string;
  /** The Mic Mode picked for this app (applied only while recording with voice processing); absent like `languageName`. */
  readonly microphoneMode?: () => MicrophoneMode;
  /** Installs the locale's speech assets; rejects with "unsupported: …" where it never will. */
  readonly prepare: (locale: string) => Promise<void>;
  /** Asks for the microphone if iOS has not yet; whether it may be used. */
  readonly requestMicrophone: () => Promise<boolean>;
  /** Opens the microphone for a phrase; a newer start replaces it. Answers the recognisers that listen. */
  readonly start: (
    session: number,
    locale: string,
    voiceProcessing: boolean,
  ) => Promise<{ readonly sources: ReadonlyArray<'accurate' | 'quick'> }>;
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
