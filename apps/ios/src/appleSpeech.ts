import {
  heardFromSegments,
  listenedLocale,
  MicrophoneDeniedError,
  SpeechUnsupportedError,
  type SpeechToText,
} from '@calendar/ai';
import { loadSpeechModule } from '../modules/solunivo-speech/index.ts';
import { dictationLanguage, secondLanguage } from './dictationLanguages.ts';
import { voiceProcessing } from './voiceProcessing.ts';

/** The iPhone's own language: what dictation listens in unless Settings › Dictation picks another. */
export const deviceLocale = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  } catch {
    return 'en-US';
  }
};

/** Locale for recognition, so dictating German transcribes German: Settings › Dictation › Language. */
export const dictationLocale = (): string =>
  listenedLocale(dictationLanguage.get(), deviceLocale());

const unsupported = () =>
  new SpeechUnsupportedError({ message: 'Speech recognition is not built into this app.' });

type Native = NonNullable<ReturnType<typeof loadSpeechModule>>;

/**
 * The languages to listen in, as Settings › Dictation has them now. A
 * binary built before the module took the second language (a stale local
 * dev client) is asked as before: its functions take one argument fewer.
 */
const languagesFor = (native: Native) =>
  native.languages === undefined
    ? { locale: deviceLocale(), second: undefined }
    : { locale: dictationLocale(), second: secondLanguage.get() };

/**
 * The languages last prepared: a phrase in others (picked in Settings
 * while an editor stayed open) prepares them first, since only preparing
 * installs a language's assets.
 */
let preparedFor: string | undefined;

const prepareIn = async (native: Native) => {
  const { locale, second } = languagesFor(native);
  try {
    // Installs the locale's models; a no-op once present.
    await (second === undefined
      ? (native.prepare as (locale: string) => Promise<void>)(locale)
      : native.prepare(locale, second));
    preparedFor = `${locale} ${second ?? ''}`;
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
};

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
    return result ? heardFromSegments(result.segments, result.other) : undefined;
  },
  isSupported: async () => loadSpeechModule() !== undefined,
  prepare: async () => {
    const native = loadSpeechModule();
    if (!native) {
      throw unsupported();
    }
    await prepareIn(native);
  },
  start: async ({ onWords, signal }) => {
    const native = loadSpeechModule();
    if (!native) {
      throw unsupported();
    }
    if (!(await native.requestMicrophone())) {
      throw new MicrophoneDeniedError({ message: 'Microphone access was declined.' });
    }
    const { locale, second } = languagesFor(native);
    if (preparedFor !== `${locale} ${second ?? ''}`) {
      await prepareIn(native);
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
      ({ sources } = await (second === undefined
        ? (
            native.start as (
              session: number,
              locale: string,
              voiceProcessing: boolean,
            ) => ReturnType<Native['start']>
          )(session, locale, voiceProcessing.get())
        : native.start(session, locale, voiceProcessing.get(), second)));
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
