/** One recognised span of speech. */
export interface TranscriptSegment {
  readonly text: string;
}

/**
 * On-device speech-to-text. Mirrors `LanguageModel`: platform-free, so the
 * desktop helper can implement the same shape later (macOS 26 exposes the
 * same speech API as iOS 26).
 */
export interface SpeechToText {
  /**
   * Whether transcription is worth offering at all — the native module is
   * present. Deliberately not "ready to run": the platform reports
   * unavailable until the locale's assets are installed, and installing
   * them is what `prepare` does, so gating the UI on readiness would hide
   * dictation on a perfectly capable device that simply has not used it
   * yet.
   */
  readonly isSupported: () => Promise<boolean>;
  /**
   * Installs the locale's assets, throwing when the locale or the device
   * cannot support transcription at all. First call can take a moment, so
   * callers should show progress rather than appearing to hang.
   */
  readonly prepare: () => Promise<void>;
  /** Recorded audio file → text, or undefined when nothing was said. */
  readonly transcribeFile: (uri: string) => Promise<string | undefined>;
}

/**
 * Joins recognised segments into one phrase. Returns undefined for silence
 * so callers can stay quiet instead of parsing an empty string — a
 * recording with no speech should not open an empty editor.
 */
export const transcriptFromSegments = (
  segments: ReadonlyArray<TranscriptSegment>,
): string | undefined => {
  const text = segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(' ')
    // Recognisers can emit doubled spaces around segment joins.
    .replaceAll(/\s+/g, ' ')
    .trim();
  return text || undefined;
};
