import { useLocationField } from '@calendar/app-state';
import type { PlaceSuggestion } from '@calendar/core';
import { useState } from 'react';
import {
  Keyboard,
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Row, Section } from './GroupedList.tsx';
import { SheetButton } from './SheetButton.tsx';
import { BOX_FONT_SCALE, groupedGround, type ThemeColors, useStyles, useTheme } from './theme.ts';

/**
 * The editor's location, chosen on a screen of its own as iOS does it: a
 * search field pinned at the top, MapKit's places filling the space down
 * to the keyboard — typed into the form, they opened under it. A tapped
 * place is the pick (its coordinates resolved for the map); Done, or the
 * keyboard's Done, keeps the text as typed, since free text is always a
 * valid location, and with the field cleared takes the location away.
 * Cancel and a swipe down leave the editor as it was. The field opens on
 * the location the editor holds and already suggests places for it.
 */
export function LocationSheet({
  location,
  onCancel,
  onDone,
  onPick,
}: {
  /** The editor's location when the sheet opened: the field starts on it. */
  location: string;
  onCancel: () => void;
  onDone: (location: string) => void;
  onPick: (suggestion: PlaceSuggestion) => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const [opened] = useState(location);
  const [text, setText] = useState(location);
  // Every way out lets go of the keyboard first: a sheet unmounted while
  // its field holds it can leave the keyboard up over the editor.
  const cancel = () => {
    Keyboard.dismiss();
    onCancel();
  };
  const field = useLocationField({
    location: text,
    onPick: (suggestion) => {
      Keyboard.dismiss();
      onPick(suggestion);
    },
    searchesAtOnce: true,
    setLocation: setText,
  });
  // Text left as it opened is no edit: Done then writes nothing back.
  const done = () => {
    Keyboard.dismiss();
    if (text === opened) {
      onCancel();
    } else {
      onDone(text);
    }
  };

  return (
    <Modal animationType="slide" onRequestClose={cancel} presentationStyle="pageSheet" visible>
      <SafeAreaView style={styles.sheet}>
        <View style={styles.header}>
          <SheetButton label="Cancel" onPress={cancel} testID="location-cancel" />
          <Text
            accessibilityRole="header"
            maxFontSizeMultiplier={BOX_FONT_SCALE}
            numberOfLines={1}
            style={styles.title}
          >
            Location
          </Text>
          <SheetButton label="Done" onPress={done} primary testID="location-done" />
        </View>
        <TextInput
          accessibilityLabel="Location"
          autoCorrect={false}
          autoFocus
          // The system ⓧ: one tap empties the field, and Done then takes
          // the location away.
          clearButtonMode="while-editing"
          onChangeText={field.setText}
          onSubmitEditing={done}
          placeholder="Enter Location"
          placeholderTextColor={colors['text-secondary']}
          returnKeyType="done"
          style={styles.search}
          testID="location-input"
          value={text}
        />
        <ScrollView
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={styles.list}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
        >
          {field.open ? (
            <Section tight>
              {field.suggestions.map((place) => (
                <Row
                  disabled={field.stale}
                  key={`${place.title}\u001f${place.subtitle ?? ''}`}
                  onPress={() => field.choose(place)}
                  subtitle={place.subtitle}
                  testID="location-suggestion"
                  title={place.title}
                />
              ))}
            </Section>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    list: {
      paddingBottom: 48,
    },
    search: {
      backgroundColor: colors.surface,
      borderRadius: 20,
      color: colors.text,
      fontSize: 17,
      marginHorizontal: 16,
      marginTop: 4,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    sheet: {
      backgroundColor: groupedGround(colors),
      flex: 1,
    },
    title: {
      color: colors.text,
      flex: 1,
      fontSize: 17,
      fontWeight: '600',
      textAlign: 'center',
    },
  });
