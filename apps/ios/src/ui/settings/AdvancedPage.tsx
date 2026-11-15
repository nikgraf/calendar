import { useBackendMutations } from '@calendar/app-state';
import { useState, useSyncExternalStore } from 'react';
import { loadOpenModelRuntime } from '../../openModel.ts';
import { voiceProcessing } from '../../voiceProcessing.ts';
import { ActionRow, Footer, NavRow, Section, SettingsPage, SwitchRow } from '../GroupedList.tsx';

/**
 * Advanced: the location cache, as on the Mac, how dictation records, then
 * troubleshooting a build — Diagnostics and PR Preview. The settings file has its own page
 * (SettingsFilePage). Model Spike is listed where the binary can run a
 * model of its own: both variants since llama.rn is linked in both, so a
 * TestFlight build measures too, as PR Preview loads a pull request there.
 */
export function AdvancedPage() {
  const { clearLocationCache } = useBackendMutations();
  const [cache, setCache] = useState<'busy' | 'cleared' | 'idle'>('idle');
  const processing = useSyncExternalStore(voiceProcessing.subscribe, voiceProcessing.get);

  const clearCache = async () => {
    setCache('busy');
    try {
      await clearLocationCache(undefined);
      setCache('cleared');
    } catch {
      setCache('idle');
    }
  };

  return (
    <SettingsPage testID="settings-page-advanced">
      <Section
        footer={
          <>
            <Footer>
              Event locations are looked up on this iPhone with Apple Maps and remembered so the
              editor map opens instantly. Remembered places refresh every two weeks.
            </Footer>
            {cache === 'cleared' ? (
              <Footer testID="location-cache-cleared">
                Cleared — places are looked up again the next time an event opens.
              </Footer>
            ) : null}
          </>
        }
        header="Locations"
        testID="locations-section"
      >
        <ActionRow
          disabled={cache === 'busy'}
          onPress={() => void clearCache()}
          testID="clear-location-cache"
          title="Clear Location Cache"
        />
      </Section>
      <Section
        footer="Records through the iPhone’s echo cancellation and noise suppression. Try it where dictation misses words in a loud room; turn it off again if it misses more."
        header="Dictation"
      >
        <SwitchRow
          onValueChange={voiceProcessing.set}
          switchTestID="voice-processing"
          title="Voice Processing"
          value={processing}
        />
      </Section>
      <Section
        footer="PR Preview loads a pull request’s update into a TestFlight build."
        header="Troubleshooting"
      >
        <NavRow
          href="/settings/diagnostics"
          testID="settings-row-diagnostics"
          title="Diagnostics"
        />
        <NavRow href="/settings/pr-preview" testID="settings-row-pr-preview" title="PR Preview" />
        {loadOpenModelRuntime() ? (
          <NavRow
            href="/settings/model-spike"
            testID="settings-row-model-spike"
            title="Model Spike"
          />
        ) : null}
      </Section>
    </SettingsPage>
  );
}
