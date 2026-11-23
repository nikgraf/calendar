import { listenedLocale, readLanguage, readSecondLanguage } from '@calendar/ai';

/** The Mac's own language, as Chromium reports it: what dictation listens in unless one is picked. */
export const deviceLocale = (): string => navigator.language || 'en-US';

/** What dictation listens in: Settings › Dictation › Language. */
export const dictationLocale = (): string =>
  listenedLocale(dictationLanguage.get(), deviceLocale());

/**
 * A locale's language in English, the app's own: "German (Austria)", not
 * Chromium's "Austrian German"; the id when it has none.
 */
export const languageName = (locale: string): string => {
  try {
    return (
      new Intl.DisplayNames(['en'], { languageDisplay: 'standard', type: 'language' }).of(locale) ??
      locale
    );
  } catch {
    return locale;
  }
};

/**
 * One of Settings › Dictation's choices in the renderer's storage, which
 * both windows share: read afresh at each phrase, and heard by the other
 * window through its `storage` event. `read` turns what is stored (or
 * nothing) into what is used.
 */
const storedChoice = (key: string, read: (stored: unknown) => string) => {
  const heard = new Set<() => void>();
  return {
    get: (): string => {
      try {
        return read(window.localStorage.getItem(key) ?? undefined);
      } catch {
        return read(undefined);
      }
    },
    set: (value: string) => {
      try {
        window.localStorage.setItem(key, read(value));
      } catch {
        // Nothing to keep it in: the next phrase listens as before.
      }
      for (const listener of heard) {
        listener();
      }
    },
    subscribe: (listener: () => void) => {
      const fromOtherWindow = (event: StorageEvent) => {
        if (event.key === key) {
          listener();
        }
      };
      heard.add(listener);
      window.addEventListener('storage', fromOtherWindow);
      return () => {
        heard.delete(listener);
        window.removeEventListener('storage', fromOtherWindow);
      };
    },
  };
};

/** The language dictation listens in: `AUTOMATIC` (the Mac's) or one picked. This Mac's alone. */
export const dictationLanguage = storedChoice('dictation.language', readLanguage);

/** The second language a phrase is read in for places: `AUTOMATIC`, `OFF` or one picked. */
export const secondLanguage = storedChoice('dictation.secondLanguage', readSecondLanguage);

const KEY = 'dictation.reduceNoise';
const listeners = new Set<() => void>();

/**
 * Settings › Dictation › Reduce background noise: whether the microphone
 * dictation opens asks Chromium for its echo cancellation, noise
 * suppression and gain control. On unless turned off: Chromium's own
 * default, which dictation always had before there was a choice. This
 * Mac's choice alone, in the renderer's storage both windows share, read
 * afresh at each phrase; a choice is always written out, so an "off" stays
 * off whatever the default.
 */
export const noiseReduction = {
  get: (): boolean => {
    try {
      return window.localStorage.getItem(KEY) !== 'off';
    } catch {
      return true;
    }
  },
  set: (on: boolean) => {
    try {
      window.localStorage.setItem(KEY, on ? 'on' : 'off');
    } catch {
      // Nothing to keep it in: the next phrase records as before.
    }
    for (const listener of listeners) {
      listener();
    }
  },
  /** This window's changes, and the other window's (a `storage` event). */
  subscribe: (listener: () => void) => {
    const fromOtherWindow = (event: StorageEvent) => {
      if (event.key === KEY) {
        listener();
      }
    };
    listeners.add(listener);
    window.addEventListener('storage', fromOtherWindow);
    return () => {
      listeners.delete(listener);
      window.removeEventListener('storage', fromOtherWindow);
    };
  },
};
