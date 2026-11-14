import {
  heardFromSegments,
  MicrophoneDeniedError,
  SpeechUnsupportedError,
  type SpeechToText,
} from '@calendar/ai';
import { loadSpeechModule } from '../modules/solunivo-speech/index.ts';
import { voiceProcessing } from './voiceProcessing.ts';

/** Locale for recognition, so dictating German transcribes German. */
const locale = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  } catch {
    return 'en-US';
  }
};

const unsupported = () =>
  new SpeechUnsupportedError({ message: 'Speech recognition is not built into this app.' });

/** The phrase listened to, by the id this adapter gave it, and its words' subscription. */
let current: { readonly remove: () => void; readonly session: number } | undefined;
let sessions = 0;

/**
 * Apple's on-device SpeechAnalyzer through the app's own module
 * (`modules/solunivo-speech`): the microphone streams into it, its
 * recognisers' words come back while the phrase is said, and the phrase
 * is read whole when it is finished. Audio never leaves the device and is
 * never written to a file. The module is loaded lazily: a binary built
 * before it (an OTA update on an older build) offers no dictation rather
 * than crashing at launch.
 */
export const appleSpeech: SpeechToText = {
  cancel: async () => {
    const active = current;
    current = undefined;
    if (!active) {
      return;
    }
    active.remove();
    await loadSpeechModule()
      ?.cancel(active.session)
      .catch(() => undefined);
  },
  finish: async () => {
    const active = current;
    current = undefined;
    const native = loadSpeechModule();
    if (!active || !native) {
      return undefined;
    }
    active.remove();
    const result = await native.finish(active.session);
    return result ? heardFromSegments(result.segments) : undefined;
  },
  isSupported: async () => loadSpeechModule() !== undefined,
  prepare: async () => {
    const native = loadSpeechModule();
    if (!native) {
      throw unsupported();
    }
    try {
      // Installs the locale's models; a no-op once present.
      await native.prepare(locale());
    } catch (error) {
      // Distinguish "this device or locale never will" from "that attempt
      // failed" — installing models needs the network, and a download
      // failure must stay retryable rather than hiding dictation for good.
      const message = String(error);
      if (/not supported|unsupported|unavailable/i.test(message)) {
        throw new SpeechUnsupportedError({ message });
      }
      throw error;
    }
  },
  start: async ({ onWords, signal }) => {
    const native = loadSpeechModule();
    if (!native) {
      throw unsupported();
    }
    if (!(await native.requestMicrophone())) {
      throw new MicrophoneDeniedError({ message: 'Microphone access was declined.' });
    }
    if (signal?.aborted) {
      return undefined;
    }
    sessions += 1;
    const session = sessions;
    // Subscribed before the microphone opens: no word arrives unheard.
    const subscription = native.addListener('onWords', (event) => {
      if (event.session === session) {
        onWords(event.source, event.text);
      }
    });
    const remove = () => {
      subscription.remove();
    };
    let sources: ReadonlyArray<'accurate' | 'quick'>;
    try {
      ({ sources } = await native.start(session, locale(), voiceProcessing.get()));
    } catch (error) {
      remove();
      throw error;
    }
    // Given up while the microphone was opening: this phrase only goes.
    // The current one may be a newer caller's.
    if (signal?.aborted) {
      remove();
      await native.cancel(session).catch(() => undefined);
      return undefined;
    }
    // The module dropped the phrase before when this one started.
    current?.remove();
    current = { remove, session };
    return { sources };
  },
};
