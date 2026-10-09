import { searchTimeZones, zoneSlug } from '@calendar/core';
import { useState } from 'react';
import { Modal, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import { groupedGround, type ThemeColors, useStyles, useTheme } from '../theme.ts';
import { Row, Section, SettingsPage } from './GroupedList.tsx';

/**
 * A search box over the zone catalog; a tap on a row picks it. The rows
 * live in a scroll view that keeps taps alive with
 * keyboardShouldPersistTaps (SettingsPage), and the General page's own
 * scroll view needs the same flag: this Modal is its child in the React
 * tree, so the responder capture that dismisses the keyboard runs there
 * first (it ate the first row tap).
 */
export function TimeZonePickerSheet({
  exclude,
  onClose,
  onPick,
  visible,
}: {
  exclude: ReadonlyArray<string>;
  onClose: () => void;
  onPick: (zone: string) => void;
  visible: boolean;
}) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const [query, setQuery] = useState('');
  const matches = searchTimeZones(query, exclude);
  const close = () => {
    setQuery('');
    onClose();
  };
  return (
    <Modal
      animationType="slide"
      onRequestClose={close}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <View style={styles.sheet}>
        <SafeAreaView>
          <View style={styles.header}>
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              onPress={close}
              style={styles.headerSide}
              testID="time-zone-cancel"
            >
              <Text style={styles.cancel}>Cancel</Text>
            </Pressable>
            <Text accessibilityRole="header" style={styles.title}>
              Add Time Zone
            </Text>
            <View style={styles.headerSide} />
          </View>
        </SafeAreaView>
        <SettingsPage testID="time-zone-picker">
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            clearButtonMode="while-editing"
            onChangeText={setQuery}
            placeholder="City or Region"
            placeholderTextColor={colors['text-secondary']}
            returnKeyType="search"
            style={styles.search}
            testID="time-zone-search"
            value={query}
          />
          <Section>
            {matches.map((match) => (
              <Row
                key={match.id}
                onPress={() => {
                  setQuery('');
                  onPick(match.id);
                }}
                subtitle={match.id}
                testID={`time-zone-option-${zoneSlug(match.id)}`}
                title={match.city}
              />
            ))}
          </Section>
        </SettingsPage>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    cancel: {
      color: colors.primary,
      fontSize: 17,
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    headerSide: {
      minWidth: 64,
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
      fontSize: 17,
      fontWeight: '600',
    },
  });
