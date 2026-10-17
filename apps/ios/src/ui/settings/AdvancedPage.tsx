import { useBackendMutations } from '@calendar/app-state';
import { useState } from 'react';
import { ActionRow, Footer, NavRow, Section, SettingsPage } from '../GroupedList.tsx';

/**
 * Advanced: the location cache, as on the Mac, then troubleshooting a
 * build — Diagnostics and PR Preview. The settings file has its own page
 * (SettingsFilePage).
 */
export function AdvancedPage() {
  const { clearLocationCache } = useBackendMutations();
  const [cache, setCache] = useState<'busy' | 'cleared' | 'idle'>('idle');

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
        footer="PR Preview loads a pull request’s update into a TestFlight build."
        header="Troubleshooting"
      >
        <NavRow
          href="/settings/diagnostics"
          testID="settings-row-diagnostics"
          title="Diagnostics"
        />
        <NavRow href="/settings/pr-preview" testID="settings-row-pr-preview" title="PR Preview" />
      </Section>
    </SettingsPage>
  );
}
