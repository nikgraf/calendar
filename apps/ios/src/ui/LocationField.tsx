import { useLocationField, type useEventEditorModel } from '@calendar/app-state';
import { Pressable, Text, TextInput, View } from 'react-native';
import { sheetStyles as styles } from './editSheetShared.ts';

/**
 * The location input with MapKit suggestions under it, rendered as plain
 * pressables like InviteeField (the form's ScrollView keeps taps alive
 * with keyboardShouldPersistTaps). Free text is always a valid location;
 * a tapped row writes its label and resolves coordinates for the map.
 * The state machine is useLocationField, shared with the desktop combobox.
 */
export function LocationField({ model }: { model: ReturnType<typeof useEventEditorModel> }) {
  const { acceptEnter, choose, dismiss, open, setText, stale, suggestions } = useLocationField({
    location: model.location,
    onPick: (suggestion) => void model.pickPlace(suggestion),
    setLocation: model.setLocation,
  });

  return (
    <View>
      <TextInput
        accessibilityLabel="Location"
        autoCorrect={false}
        // Deferred: a tap on a suggestion row blurs the input first, and an
        // immediate dismiss would unmount the row under the finger.
        onBlur={() => setTimeout(dismiss, 200)}
        onChangeText={setText}
        onSubmitEditing={acceptEnter}
        placeholder="Add a location"
        returnKeyType="done"
        style={styles.input}
        testID="location-input"
        value={model.location}
      />
      {open ? (
        <View style={styles.suggestions}>
          {suggestions.map((place) => (
            <Pressable
              accessibilityRole="button"
              disabled={stale}
              key={`${place.title}\u001f${place.subtitle ?? ''}`}
              onPress={() => choose(place)}
              style={[styles.suggestion, stale && styles.suggestionStale]}
              testID="location-suggestion"
            >
              <Text style={styles.suggestionTitle}>{place.title}</Text>
              {place.subtitle ? <Text style={styles.suggestionMeta}>{place.subtitle}</Text> : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
