import { searchTimeZones, zoneSlug } from '@calendar/core';
import { useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { BOX_FONT_SCALE, groupedGround, type ThemeColors, useStyles, useTheme } from '../theme.ts';
import { CardRow, Footer, Row } from './GroupedList.tsx';

/**
 * The zone catalog in a sheet: the whole list scrolls under a search box
 * pinned above it, and typing narrows it; a tap on a row picks it. The
 * list is virtualized (the catalog is a few hundred zones) and keeps taps
 * alive with keyboardShouldPersistTaps, and the General page's own scroll
 * view needs the same flag: this Modal is its child in the React tree,
 * so the responder capture that dismisses the keyboard runs there first
 * (it ate the first row tap).
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
              <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.cancel}>
                Cancel
              </Text>
            </Pressable>
            <Text
              accessibilityRole="header"
              maxFontSizeMultiplier={BOX_FONT_SCALE}
              style={styles.title}
            >
              Add Time Zone
            </Text>
            <View style={styles.headerSide} />
          </View>
        </SafeAreaView>
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
        <FlatList
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={styles.list}
          data={matches}
          initialNumToRender={20}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          keyExtractor={(match) => match.id}
          ListEmptyComponent={
            <Footer testID="time-zone-no-match">No time zone matches “{query.trim()}”.</Footer>
          }
          renderItem={({ index, item }) => (
            <CardRow first={index === 0} last={index === matches.length - 1}>
              <Row
                onPress={() => {
                  setQuery('');
                  onPick(item.id);
                }}
                subtitle={item.id}
                testID={`time-zone-option-${zoneSlug(item.id)}`}
                title={item.city}
              />
            </CardRow>
          )}
          style={styles.listView}
          testID="time-zone-picker"
        />
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
    list: {
      paddingBottom: 48,
      paddingTop: 16,
    },
    listView: {
      flex: 1,
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
