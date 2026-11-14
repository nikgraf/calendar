import type { SpeechToText } from '@calendar/ai';
import { appleSpeech } from './appleSpeech.ts';
import { fixtureSpeech } from './fixtureSpeech.ts';

/**
 * Dictation: Apple's SpeechAnalyzer through the app's speech module, or
 * with `EXPO_PUBLIC_CALENDAR_SPEECH=fixture` (inlined at bundle time) a
 * script said word by word, for a simulator, which has no speech assets.
 */
export const speech: SpeechToText =
  process.env['EXPO_PUBLIC_CALENDAR_SPEECH'] === 'fixture' ? fixtureSpeech : appleSpeech;
