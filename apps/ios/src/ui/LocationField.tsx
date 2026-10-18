import { useLocationField, type useEventEditorModel } from '@calendar/app-state';
import { FieldFlash } from './FlashView.tsx';
import { FieldRow, Row, Rows } from './GroupedList.tsx';

/**
 * The location row of the title card, with MapKit's suggestions as rows
 * under it while it is typed into (the form's ScrollView keeps taps alive
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
    <Rows>
      <FieldFlash bleedX={0} bleedY={0} field="location" radius={0}>
        <FieldRow
          accessibilityLabel="Location"
          autoCorrect={false}
          // Deferred: a tap on a suggestion row blurs the input first, and an
          // immediate dismiss would unmount the row under the finger.
          onBlur={() => setTimeout(dismiss, 200)}
          onChangeText={setText}
          onSubmitEditing={acceptEnter}
          placeholder="Location"
          returnKeyType="done"
          testID="location-input"
          value={model.location}
        />
      </FieldFlash>
      {open
        ? suggestions.map((place) => (
            <Row
              disabled={stale}
              key={`${place.title}\u001f${place.subtitle ?? ''}`}
              onPress={() => choose(place)}
              subtitle={place.subtitle}
              testID="location-suggestion"
              title={place.title}
            />
          ))
        : null}
    </Rows>
  );
}
