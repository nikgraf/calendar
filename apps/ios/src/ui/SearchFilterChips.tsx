import { type SearchFilterChip, searchChipId } from '@calendar/core';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { FlashView } from './FlashView.tsx';
import { BOX_FONT_SCALE, type ThemeColors, useStyles } from './theme.ts';

/**
 * The search's filters as a row of chips under the header: a tap opens
 * the Filters sheet, × takes one away, "Filters" opens the sheet to add
 * one, "Clear" resets words, filters and turns. Scrolls sideways like
 * the Tasks tab's list chips; a chip never stretches. The chips a
 * sentence added or changed flash (`flash`).
 */
export function SearchFilterChips({
  chips,
  flash,
  onClear,
  onOpenFilters,
  onRemove,
  showClear,
}: {
  chips: ReadonlyArray<SearchFilterChip>;
  /** The newest turn's chips, while their flash plays (`useSearchThread().flash`). */
  flash: { readonly chips: ReadonlySet<string>; readonly key: string } | null;
  onClear: () => void;
  onOpenFilters: () => void;
  onRemove: (chip: SearchFilterChip) => void;
  showClear: boolean;
}) {
  const styles = useStyles(makeStyles);
  return (
    <ScrollView
      contentContainerStyle={styles.row}
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
      style={styles.scroller}
      testID="search-chips"
    >
      {chips.map((chip) => (
        <FlashView
          bleedX={0}
          bleedY={0}
          flash={flash?.chips.has(searchChipId(chip)) ? flash.key : null}
          key={searchChipId(chip)}
          radius={8}
          style={styles.chip}
        >
          <Pressable
            accessibilityRole="button"
            hitSlop={4}
            onPress={onOpenFilters}
            testID={`search-chip-${chip.field}${chip.key === undefined ? '' : `-${chip.key}`}`}
          >
            <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.label}>
              {chip.label}
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel={`Remove ${chip.label}`}
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => onRemove(chip)}
            testID="search-chip-remove"
          >
            <Text style={styles.remove}>×</Text>
          </Pressable>
        </FlashView>
      ))}
      <Pressable
        accessibilityRole="button"
        onPress={onOpenFilters}
        style={styles.add}
        testID="search-filters"
      >
        <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.addLabel}>
          + Filters
        </Text>
      </Pressable>
      {showClear ? (
        <Pressable
          accessibilityRole="button"
          onPress={onClear}
          style={styles.add}
          testID="search-clear"
        >
          <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.addLabel}>
            Clear
          </Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    add: {
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 5,
    },
    addLabel: {
      color: colors.primary,
      fontSize: 14,
      fontWeight: '500',
    },
    chip: {
      alignItems: 'center',
      backgroundColor: colors.fill,
      borderRadius: 8,
      flexDirection: 'row',
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    label: {
      color: colors.text,
      fontSize: 14,
    },
    remove: {
      color: colors['text-secondary'],
      fontSize: 16,
      lineHeight: 18,
    },
    row: {
      alignItems: 'center',
      gap: 6,
      paddingVertical: 4,
    },
    // A horizontal ScrollView in a column stretches unless told not to.
    scroller: {
      flexGrow: 0,
      flexShrink: 0,
    },
  });
