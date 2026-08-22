import { transcriptFromSegments, type SpeechToText } from '@calendar/ai';
import { File } from 'expo-file-system';

/**
 * Locale for recognition — dictating German should transcribe German, and
 * the parser handles German phrasing too.
 */
const locale = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  } catch {
    return 'en-US';
  }
};

/**
 * Loaded lazily for the same reason as the model provider: the package
 * resolves its turbo modules with `getEnforcing`, which throws while the
 * module is evaluated, so a static import crashes the app at launch on a
 * binary built without the pod.
 */
const loadModule = (): typeof import('@react-native-ai/apple') | undefined => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
    return require('@react-native-ai/apple') as typeof import('@react-native-ai/apple');
  } catch {
    return undefined;
  }
};

/**
 * Apple's on-device SpeechAnalyzer/SpeechTranscriber. Audio never leaves
 * the device and the recording is deleted as soon as it is transcribed.
 */
export const appleSpeech: SpeechToText = {
  isSupported: async () => loadModule() !== undefined,
  prepare: async () => {
    const module = loadModule();
    if (!module) {
      throw new Error('Speech recognition is not built into this app.');
    }
    // Installs the locale's models; a no-op once they are present.
    await module.AppleTranscription.prepare(locale());
  },
  transcribeFile: async (uri) => {
    const module = loadModule();
    if (!module) {
      throw new Error('Speech recognition is not built into this app.');
    }
    const file = new File(uri);
    try {
      const audio = await file.arrayBuffer();
      const result = await module.AppleTranscription.transcribe(audio, locale());
      return transcriptFromSegments(result.segments);
    } finally {
      // Voice data must not linger, even when transcription failed.
      try {
        file.delete();
      } catch {
        // Already gone, or never written.
      }
    }
  },
};
