import type { useEventEditorModel } from '@calendar/app-state';
import { useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import { FieldFlash } from './FlashView.tsx';
import { Glyph } from './GroupedList.tsx';
import { LocationSheet } from './LocationSheet.tsx';
import { type ThemeColors, useStyles, useTheme } from './theme.ts';

/**
 * The editor's Location row: the location as text, a tap opens the
 * location screen (`LocationSheet`) to search for a place or type one,
 * and the ⓧ takes the location away in one press. Read-only, it is just
 * the text.
 */
export function LocationField({
  model,
  readOnly,
}: {
  model: ReturnType<typeof useEventEditorModel>;
  readOnly: boolean;
}) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const [choosing, setChoosing] = useState(false);
  const { location } = model;

  return (
    <FieldFlash bleedX={0} bleedY={0} field="location" radius={0}>
      <View style={styles.row}>
        <Pressable
          accessibilityHint={readOnly ? undefined : 'Opens the location search'}
          accessibilityLabel={location === '' ? 'Location' : `Location, ${location}`}
          accessibilityRole="button"
          disabled={readOnly}
          onPress={() => {
            // A field still focused (the title, just typed) would get the
            // keyboard back over the form once the sheet goes: UIKit
            // restores the first responder its presenter had.
            Keyboard.dismiss();
            setChoosing(true);
          }}
          style={({ pressed }) => [styles.text, pressed && styles.pressed]}
          testID="location-field"
        >
          <Text numberOfLines={2} style={location === '' ? styles.placeholder : styles.value}>
            {location === '' ? 'Location' : location}
          </Text>
        </Pressable>
        {location === '' || readOnly ? null : (
          <Pressable
            accessibilityLabel="Remove location"
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => model.setLocation('')}
            style={styles.clear}
            testID="location-clear"
          >
            <Glyph name="xmark.circle.fill" size={20} tintColor={colors['border-strong']} />
          </Pressable>
        )}
      </View>
      {choosing ? (
        <LocationSheet
          location={location}
          onClose={() => setChoosing(false)}
          onPick={(suggestion) => {
            setChoosing(false);
            void model.pickPlace(suggestion);
          }}
          setLocation={model.setLocation}
        />
      ) : null}
    </FieldFlash>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    clear: {
      paddingLeft: 8,
      paddingRight: 16,
    },
    placeholder: {
      color: colors['text-secondary'],
      fontSize: 17,
      lineHeight: 22,
    },
    pressed: {
      backgroundColor: colors.border,
    },
    row: {
      alignItems: 'center',
      flexDirection: 'row',
    },
    text: {
      alignSelf: 'stretch',
      flex: 1,
      justifyContent: 'center',
      minHeight: 52,
      paddingLeft: 16,
      paddingRight: 16,
      paddingVertical: 15,
    },
    value: {
      color: colors.text,
      fontSize: 17,
      lineHeight: 22,
    },
  });
