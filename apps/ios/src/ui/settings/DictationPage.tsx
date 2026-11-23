import { AUTOMATIC, OFF, secondLanguageNow } from '@calendar/ai';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { type MicrophoneMode, loadSpeechModule } from '../../../modules/solunivo-speech/index.ts';
import { secondLanguage } from '../../dictationLanguages.ts';
import { voiceProcessing } from '../../voiceProcessing.ts';
import { Footer, NavRow, Row, Section, SettingsPage, SwitchRow } from '../GroupedList.tsx';
import { languageLabel, useDictationLocale, useSpeechLanguages } from './DictationLanguagePage.tsx';

const MODE_LABELS: Record<MicrophoneMode, string> = {
  standard: 'Standard',
  voiceIsolation: 'Voice Isolation',
  wideSpectrum: 'Wide Spectrum',
};

/**
 * The Mic Mode picked for the app, read again whenever the app comes back:
 * it is chosen in Control Center, so a change arrives with no event.
 */
const useMicrophoneMode = (): MicrophoneMode | undefined => {
  const native = loadSpeechModule();
  const [mode, setMode] = useState(() => native?.microphoneMode?.());
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setMode(loadSpeechModule()?.microphoneMode?.());
      }
    });
    return () => subscription.remove();
  }, []);
  return mode;
};

/**
 * What Second Language shows: Off, the language it comes to, None; and
 * nothing while Automatic's is not known yet.
 */
const secondValue = (
  chosen: string,
  second: string | undefined,
  known: boolean,
): string | undefined => {
  if (chosen === OFF) {
    return 'Off';
  }
  if (chosen === AUTOMATIC && !known) {
    return undefined;
  }
  return second === undefined ? 'None' : languageLabel(second);
};

/**
 * Dictation: how the microphone records (voice processing, on by default,
 * and iOS's Mic Mode on top of it, shown but chosen in Control Center while
 * dictating, where iOS offers it), and the two languages: the one it
 * listens in and the second a phrase is read in for places, each
 * Automatic until picked (`DictationLanguagePage`). A binary built before
 * the module could list its languages shows the language only.
 */
export function DictationPage() {
  const reduceNoise = useSyncExternalStore(voiceProcessing.subscribe, voiceProcessing.get);
  const mode = useMicrophoneMode();
  const native = loadSpeechModule();
  const locale = useDictationLocale();
  const chosenSecond = useSyncExternalStore(secondLanguage.subscribe, secondLanguage.get);
  const languages = useSpeechLanguages(locale);
  const second = secondLanguageNow(chosenSecond, languages?.automatic, locale);

  return (
    <SettingsPage testID="settings-page-dictation">
      <Section
        footer={
          <>
            <Footer>Filters out background noise and echo while you dictate.</Footer>
            {reduceNoise && mode !== undefined ? (
              <Footer>
                Voice Isolation also keeps out other voices, such as someone talking next to you. To
                choose it, open Control Center while you dictate and tap Mic Mode.
              </Footer>
            ) : null}
          </>
        }
      >
        <SwitchRow
          onValueChange={voiceProcessing.set}
          switchTestID="reduce-background-noise"
          title="Reduce Background Noise"
          value={reduceNoise}
        />
        {/* Mic Mode applies only to audio recorded through voice processing. */}
        {reduceNoise && mode !== undefined ? (
          <Row
            testID="dictation-mic-mode"
            title="Mic Mode"
            value={MODE_LABELS[mode]}
            valueTestID="dictation-mic-mode-value"
          />
        ) : null}
      </Section>
      {native?.languages === undefined ? (
        <Section footer="Dictation listens in this iPhone’s language. Change it in the Settings app, under General › Language & Region.">
          <Row testID="dictation-language" title="Language" value={languageLabel(locale)} />
        </Section>
      ) : (
        <Section footer="Dictation listens in the language. Each phrase is read in the second language too, so a place said that language’s way is found, such as a German place in an English sentence.">
          <NavRow
            href="/settings/dictation-language"
            testID="dictation-language"
            title="Language"
            value={languageLabel(locale)}
            valueTestID="dictation-language-value"
          />
          <NavRow
            href="/settings/dictation-second-language"
            testID="dictation-second-language"
            title="Second Language"
            value={secondValue(chosenSecond, second, languages?.settled === true)}
            valueTestID="dictation-second-language-value"
          />
        </Section>
      )}
    </SettingsPage>
  );
}
