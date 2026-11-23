/**
 * Settings › Dictation's two languages, the same on both apps and kept on
 * each device: the one dictation listens in, and the second one a phrase
 * is read in too, for the place lookup (`Heard.other`). Each is worked
 * out from the device until the user picks one (`AUTOMATIC`); the second
 * may also be none (`OFF`). A picked language is a BCP 47 id ("de-AT").
 */

/** Worked out from the device: its language, or (second) the native side's rule. */
export const AUTOMATIC = 'auto';
/** No second language: a phrase is read once. */
export const OFF = 'off';

const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** A stored language choice as it may be used: anything else (an older note, a typo) is automatic. */
export const readLanguage = (value: unknown): string =>
  typeof value === 'string' && LOCALE.test(value) ? value : AUTOMATIC;

/** A stored second-language choice as it may be used: off, a language, or automatic. */
export const readSecondLanguage = (value: unknown): string =>
  value === OFF ? OFF : readLanguage(value);

/** The language dictation listens in: the one picked, else the device's. */
export const listenedLocale = (chosen: string, device: string): string =>
  chosen === AUTOMATIC ? device : chosen;

/** The language part of an id: "de" of "de-AT". */
const languageOf = (locale: string): string => locale.split('-')[0]!.toLowerCase();

/** One language to pick, as the list shows it. */
export interface LanguageOption {
  readonly id: string;
  readonly name: string;
}

/**
 * The languages the recogniser has, as a list to pick from, by name. The
 * one picked stays on it when the recogniser no longer lists it (an
 * update dropped it), so the choice can be seen and changed. `besides`:
 * for the second language, the one listened in, whose language a second
 * reading would only repeat, is left out.
 */
export const languageOptions = (
  available: ReadonlyArray<string>,
  chosen: string,
  nameOf: (locale: string) => string,
  besides?: string,
): ReadonlyArray<LanguageOption> => {
  const ids = new Set(available);
  if (chosen !== AUTOMATIC && chosen !== OFF) {
    ids.add(chosen);
  }
  return [...ids]
    .filter((id) => besides === undefined || languageOf(id) !== languageOf(besides))
    .map((id) => ({ id, name: nameOf(id) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
};

/**
 * What the second language comes to, as Settings › Dictation shows it:
 * the language, or nothing when it is off, or automatic finds none (the
 * device knows one language only).
 */
export const secondLanguageNow = (
  chosen: string,
  automatic: string | undefined,
  listened: string,
): string | undefined => {
  if (chosen === OFF) {
    return undefined;
  }
  if (chosen === AUTOMATIC) {
    return automatic;
  }
  return languageOf(chosen) === languageOf(listened) ? undefined : chosen;
};
