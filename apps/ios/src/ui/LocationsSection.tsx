import { useBackendMutations } from '@calendar/app-state';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { sectionStyles } from './settingsShared.ts';

/**
 * The on-device geocode cache behind the editor map. Entries refresh on
 * their own (see locationHandlers), but a wipe is the escape hatch for a
 * place Apple Maps got wrong and the user wants looked up afresh.
 */
export function LocationsSection() {
  const { clearLocationCache } = useBackendMutations();
  const [state, setState] = useState<'busy' | 'cleared' | 'idle'>('idle');

  const clear = async () => {
    setState('busy');
    try {
      await clearLocationCache(undefined);
      setState('cleared');
    } catch {
      setState('idle');
    }
  };

  return (
    <View style={sectionStyles.card} testID="locations-section">
      <Text style={sectionStyles.title}>Locations</Text>
      <Text style={sectionStyles.meta}>
        Event locations are looked up on this device with Apple Maps and remembered so the editor
        map opens instantly. Remembered places refresh every 30 days.
      </Text>
      <Pressable
        disabled={state === 'busy'}
        onPress={() => void clear()}
        style={state === 'busy' && sectionStyles.busy}
        testID="clear-location-cache"
      >
        <Text style={[sectionStyles.action, { marginTop: 10 }]}>Clear location cache</Text>
      </Pressable>
      {state === 'cleared' ? (
        <Text style={sectionStyles.meta}>
          Cleared — places are looked up again the next time an event opens.
        </Text>
      ) : null}
    </View>
  );
}
