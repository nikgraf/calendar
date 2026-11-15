import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { type MicrophoneMode, loadSpeechModule } from '../../../modules/solunivo-speech/index.ts';
import { dictationLocale } from '../../appleSpeech.ts';
import { voiceProcessing } from '../../voiceProcessing.ts';
import { Footer, Row, Section, SettingsPage, SwitchRow } from '../GroupedList.tsx';

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
 * Dictation: how the microphone records (voice processing, on by default,
 * and iOS's Mic Mode on top of it, shown but chosen in Control Center while
 * dictating, where iOS offers it), and the language it listens in, which
 * is the iPhone's own.
 */
export function DictationPage() {
  const reduceNoise = useSyncExternalStore(voiceProcessing.subscribe, voiceProcessing.get);
  const mode = useMicrophoneMode();
  const native = loadSpeechModule();
  const locale = dictationLocale();

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
      <Section footer="Dictation listens in this iPhone’s language. Change it in the Settings app, under General › Language & Region.">
        <Row
          testID="dictation-language"
          title="Language"
          value={native?.languageName?.(locale) ?? locale}
        />
      </Section>
    </SettingsPage>
  );
}
