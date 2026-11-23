import { AUTOMATIC, languageOptions, listenedLocale, OFF, secondAfter } from '@calendar/ai';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { loadSpeechModule } from '../../../modules/solunivo-speech/index.ts';
import { deviceLocale, dictationLocale } from '../../appleSpeech.ts';
import { dictationLanguage, secondLanguage } from '../../dictationLanguages.ts';
import { CheckRow, Section, SettingsPage } from '../GroupedList.tsx';

/** What the recogniser has, for the language listened in. */
interface SpeechLanguages {
  /** The second language Automatic comes to; none when the iPhone knows one language only. */
  readonly automatic?: string | undefined;
  readonly available: ReadonlyArray<string>;
}

/**
 * The languages dictation may listen in, and the second language
 * Automatic comes to for `locale`, as the native module answers; nothing
 * until it has, and nothing on a binary built before it could.
 */
export const useSpeechLanguages = (locale: string): SpeechLanguages | undefined => {
  const [answer, setAnswer] = useState<
    { readonly languages: SpeechLanguages; readonly locale: string } | undefined
  >();
  useEffect(() => {
    let gone = false;
    loadSpeechModule()
      ?.languages?.(locale)
      .then((languages) => {
        if (!gone) {
          setAnswer({ languages, locale });
        }
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [locale]);
  return answer?.locale === locale ? answer.languages : undefined;
};

/** A language as the app names it: "German (Austria)". */
export const languageLabel = (locale: string): string =>
  loadSpeechModule()?.languageName?.(locale) ?? locale;

/** The language dictation listens in, Settings › Dictation's choice made reactive. */
export const useDictationLocale = (): string => {
  useSyncExternalStore(dictationLanguage.subscribe, dictationLanguage.get);
  return dictationLocale();
};

/** Picks the language listened in; a second picked in that language goes back to Automatic. */
const pickLanguage = (language: string) => {
  dictationLanguage.set(language);
  secondLanguage.set(secondAfter(secondLanguage.get(), listenedLocale(language, deviceLocale())));
};

/**
 * Settings › Dictation › Language: Automatic (the iPhone's own language)
 * or one the recogniser has. A language is downloaded the first time
 * dictation is used in it.
 */
export function DictationLanguagePage() {
  const chosen = useSyncExternalStore(dictationLanguage.subscribe, dictationLanguage.get);
  const languages = useSpeechLanguages(useDictationLocale());
  const options = languageOptions(languages?.available ?? [], chosen, languageLabel);
  return (
    <SettingsPage testID="settings-page-dictation-language">
      <Section footer="Automatic listens in this iPhone’s language: change it in the Settings app, under General › Language & Region. Another language is downloaded the first time you dictate in it.">
        <CheckRow
          checked={chosen === AUTOMATIC}
          onPress={() => pickLanguage(AUTOMATIC)}
          subtitle={languageLabel(deviceLocale())}
          testID={`dictation-language-automatic${chosen === AUTOMATIC ? '-on' : ''}`}
          title="Automatic"
        />
      </Section>
      {options.length > 0 ? (
        <Section header="Languages">
          {options.map((option) => (
            <CheckRow
              checked={chosen === option.id}
              key={option.id}
              onPress={() => pickLanguage(option.id)}
              testID={`dictation-language-${option.id}${chosen === option.id ? '-on' : ''}`}
              title={option.name}
            />
          ))}
        </Section>
      ) : null}
    </SettingsPage>
  );
}

/**
 * Settings › Dictation › Second Language: each phrase is read in it too,
 * and the place names it hears are searched (`Heard.other`). Automatic,
 * the native side's rule (one of the iPhone's other languages, its
 * keyboards, its region's language); Off; or one picked. The language
 * listened in is not offered: a second reading in it would repeat the
 * first.
 */
export function SecondLanguagePage() {
  const chosen = useSyncExternalStore(secondLanguage.subscribe, secondLanguage.get);
  const listened = useDictationLocale();
  const languages = useSpeechLanguages(listened);
  const options = languageOptions(languages?.available ?? [], chosen, languageLabel, listened);
  const automatic = languages?.automatic;
  return (
    <SettingsPage testID="settings-page-dictation-second-language">
      <Section footer="Each phrase is read in this language too, and the place names it hears are searched: a German place in an English sentence is found. Automatic takes another of this iPhone’s languages or keyboards, or its region’s language.">
        <CheckRow
          checked={chosen === AUTOMATIC}
          onPress={() => secondLanguage.set(AUTOMATIC)}
          subtitle={
            languages === undefined
              ? undefined
              : automatic === undefined
                ? 'None on this iPhone'
                : languageLabel(automatic)
          }
          testID={`dictation-second-language-automatic${chosen === AUTOMATIC ? '-on' : ''}`}
          title="Automatic"
        />
        <CheckRow
          checked={chosen === OFF}
          onPress={() => secondLanguage.set(OFF)}
          testID={`dictation-second-language-off${chosen === OFF ? '-on' : ''}`}
          title="Off"
        />
      </Section>
      {options.length > 0 ? (
        <Section header="Languages">
          {options.map((option) => (
            <CheckRow
              checked={chosen === option.id}
              key={option.id}
              onPress={() => secondLanguage.set(option.id)}
              testID={`dictation-second-language-${option.id}${chosen === option.id ? '-on' : ''}`}
              title={option.name}
            />
          ))}
        </Section>
      ) : null}
    </SettingsPage>
  );
}
