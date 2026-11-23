import { AUTOMATIC, languageOptions, listenedLocale, OFF, secondAfter } from '@calendar/ai';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  deviceLocale,
  dictationLanguage,
  languageName,
  noiseReduction,
  secondLanguage,
} from './ai/dictationSettings.ts';
import { FIELD_CLASS, LABEL_CLASS } from './ui/fieldStyles.ts';

/** What the recogniser has, for the language listened in. */
interface SpeechLanguages {
  readonly automatic?: string | undefined;
  readonly available: ReadonlyArray<string>;
}

/**
 * The languages dictation may listen in, and the second language
 * Automatic comes to for `locale`, as the helper answers; nothing until
 * it has, or when it cannot (no helper).
 */
const useSpeechLanguages = (
  locale: string,
): (SpeechLanguages & { readonly settled: boolean }) | undefined => {
  const [answer, setAnswer] = useState<
    { readonly languages: SpeechLanguages; readonly locale: string } | undefined
  >();
  useEffect(() => {
    let gone = false;
    window.calendarBridge
      .modelSpeechLanguages(locale)
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
  if (answer === undefined) {
    return undefined;
  }
  // The list is the recogniser's whatever the language; Automatic's second
  // is known only for the language it was asked about.
  return answer.locale === locale
    ? { ...answer.languages, settled: true }
    : { available: answer.languages.available, settled: false };
};

/**
 * Settings › Dictation: how the microphone records (Chromium's voice
 * processing, on by default) and the two languages: the one dictation
 * listens in and the second a phrase is read in for places, each
 * Automatic until picked. All this Mac's alone, like the iPhone's page.
 */
export function DictationSection() {
  const reduceNoise = useSyncExternalStore(noiseReduction.subscribe, noiseReduction.get);
  const chosen = useSyncExternalStore(dictationLanguage.subscribe, dictationLanguage.get);
  const chosenSecond = useSyncExternalStore(secondLanguage.subscribe, secondLanguage.get);
  const device = deviceLocale();
  const listened = listenedLocale(chosen, device);
  const languages = useSpeechLanguages(listened);
  const available = languages?.available ?? [];
  const automatic = languages?.automatic;

  return (
    <>
      <section className="rounded-popover bg-surface-subtle p-4" data-testid="dictation-microphone">
        <h2 className="font-medium">Microphone</h2>
        <p className="mt-1 text-sm text-ink-secondary">
          Filters out background noise and echo while you dictate.
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            aria-label="Reduce background noise"
            checked={reduceNoise}
            data-testid="reduce-background-noise"
            onChange={(change) => noiseReduction.set(change.target.checked)}
            type="checkbox"
          />
          Reduce background noise
        </label>
      </section>
      <section className="rounded-popover bg-surface-subtle p-4" data-testid="dictation-language">
        <h2 className="font-medium">Language</h2>
        <p className="mt-1 text-sm text-ink-secondary">
          Dictation listens in the language. Each phrase is read in the second language too, so a
          place said that language&rsquo;s way is found, such as a German place in an English
          sentence. Automatic follows this Mac&rsquo;s languages and region (System Settings ›
          General › Language &amp; Region).
        </p>
        <label className={`${LABEL_CLASS} mt-3 block`}>
          Language
          <select
            className={`${FIELD_CLASS} mt-1`}
            data-testid="dictation-language-select"
            onChange={(change) => {
              const picked = change.target.value;
              dictationLanguage.set(picked);
              // A second picked in that language would only repeat it.
              secondLanguage.set(secondAfter(chosenSecond, listenedLocale(picked, device)));
            }}
            value={chosen}
          >
            <option value={AUTOMATIC}>Automatic — {languageName(device)}</option>
            {languageOptions(available, chosen, languageName).map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
        <label className={`${LABEL_CLASS} mt-3 block`}>
          Second language
          <select
            className={`${FIELD_CLASS} mt-1`}
            data-testid="dictation-second-language-select"
            onChange={(change) => secondLanguage.set(change.target.value)}
            value={chosenSecond}
          >
            <option value={AUTOMATIC}>
              {languages?.settled !== true
                ? 'Automatic'
                : `Automatic — ${automatic === undefined ? 'none on this Mac' : languageName(automatic)}`}
            </option>
            <option value={OFF}>Off</option>
            {languageOptions(available, chosenSecond, languageName, listened).map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
      </section>
    </>
  );
}
