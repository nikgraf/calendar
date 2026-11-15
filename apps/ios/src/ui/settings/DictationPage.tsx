import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { type MicrophoneMode, loadSpeechModule } from '../../../modules/solunivo-speech/index.ts';
import { dictationLocale } from '../../appleSpeech.ts';
import { voiceProcessing } from '../../voiceProcessing.ts';
import { Chevron, Footer, Row, Section, SettingsPage, SwitchRow } from '../GroupedList.tsx';

const MODE_LABELS: Record<MicrophoneMode, string> = {
  standard: 'Standard',
  voiceIsolation: 'Voice Isolation',
  wideSpectrum: 'Wide Spectrum',
};

/**
 * The Mic Mode picked for the app, read again whenever the app comes back:
 * the picker is iOS's own, so a choice made there arrives with no event.
 */
const useMicrophoneMode = (): MicrophoneMode | undefined => {
  const native = loadSpeechModule();
  const [mode, setMode] = useState(() => native?.microphoneMode());
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setMode(loadSpeechModule()?.microphoneMode());
      }
    });
    return () => subscription.remove();
  }, []);
  return mode;
};

/**
 * Dictation: how the microphone records (voice processing, on by default,
 * and iOS's Mic Mode on top of it), and the language it listens in, which
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
                In Mic Mode, Voice Isolation also keeps out other voices, such as someone talking
                next to you.
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
        {reduceNoise && native && mode !== undefined ? (
          <Row
            accessory={<Chevron />}
            onPress={() => void native.showMicrophoneModes()}
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
          value={native?.languageName(locale) ?? locale}
        />
      </Section>
    </SettingsPage>
  );
}
