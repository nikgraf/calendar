/** What dictation listens in: the Mac's language, as Chromium reports it. */
export const dictationLocale = (): string => navigator.language || 'en-US';

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
