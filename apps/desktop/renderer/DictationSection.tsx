import {
  AUTOMATIC,
  languageOptions,
  listenedLocale,
  OFF,
  parakeetCopy,
  secondAfter,
} from '@calendar/ai';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  deviceLocale,
  dictationLanguage,
  languageName,
  noiseReduction,
  secondLanguage,
} from './ai/dictationSettings.ts';
import { useParakeetState } from './ai/parakeetModel.ts';
import { SETTINGS_HASH } from './settingsPanes.ts';
import { SETTINGS_BUTTON_CLASS, TEXT_ACTION_CLASS, TEXT_LINK_CLASS } from './ui/buttonStyles.ts';
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
 * Read With Parakeet, as on the iPhone: the switch (on from the start),
 * where the files stand with the one action that state offers, and Delete
 * once they are here. Nothing until main answered, or where this run has none.
 */
function ParakeetSection() {
  const state = useParakeetState();
  if (state === undefined || state.files.kind === 'unsupported') {
    return null;
  }
  const { files, on } = state;
  const copy = parakeetCopy(files, { device: 'Mac', network: undefined });
  const act = () => {
    if (copy.action?.kind === 'retry') {
      void window.calendarBridge.parakeetRetry();
    } else {
      void window.calendarBridge.parakeetDownload();
    }
  };
  return (
    <section className="rounded-popover bg-surface-subtle p-4" data-testid="dictation-parakeet">
      <h2 className="font-medium">Speech Model</h2>
      <p className="mt-1 text-sm text-ink-secondary">
        The speech model listens to each phrase again on this Mac and spells the people and places
        from your calendar and contacts. Off, or until it is downloaded, Apple&rsquo;s words go as
        they are. NVIDIA&rsquo;s Parakeet, as moondream&rsquo;s Ultra, CC BY 4.0.{' '}
        <button
          className={TEXT_LINK_CLASS}
          data-testid="dictation-how-assistant-works"
          onClick={() => window.location.replace(`${SETTINGS_HASH}/model`)}
          type="button"
        >
          How the Assistant works
        </button>
      </p>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          aria-label="Read with Parakeet"
          checked={on}
          data-testid="read-with-parakeet"
          onChange={(change) => void window.calendarBridge.parakeetSetOn(change.target.checked)}
          type="checkbox"
        />
        Read with Parakeet
      </label>
      <p className="mt-3 text-sm" data-testid="parakeet-status">
        {copy.line}
      </p>
      {copy.progress === undefined ? null : (
        <div
          aria-label={`${String(copy.progress)} percent downloaded`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={copy.progress}
          className="mt-2 h-1 w-full overflow-hidden rounded-full bg-hairline-strong"
          role="progressbar"
        >
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${String(copy.progress)}%` }}
          />
        </div>
      )}
      <div className="mt-3 flex items-center gap-4">
        {copy.action === undefined ? null : (
          <button
            className={SETTINGS_BUTTON_CLASS}
            data-testid="parakeet-action"
            onClick={act}
            type="button"
          >
            {copy.action.label}
          </button>
        )}
        {files.kind === 'ready' ? (
          <button
            className={`text-sm ${TEXT_ACTION_CLASS.danger}`}
            data-testid="parakeet-delete"
            onClick={() => void window.calendarBridge.parakeetRemove()}
            type="button"
          >
            Delete Speech Model
          </button>
        ) : null}
      </div>
    </section>
  );
}

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
      <ParakeetSection />
    </>
  );
}
