import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BOX_FONT_SCALE, type ThemeColors, useStyles } from './theme.ts';

export interface SegmentedOption<T extends string> {
  readonly disabled?: boolean | undefined;
  readonly label: string;
  readonly testID?: string | undefined;
  readonly value: T;
}

/**
 * One choice among a few, drawn as a soft-filled track with the chosen
 * segment lifted onto a surface — the editor's Event | Task | Reminder
 * control and the quick-add field's Add | Find time. Drawn here rather
 * than SwiftUI's so each segment carries its own test id for the flows.
 */
export function SegmentedControl<T extends string>({
  accessibilityLabel,
  grow = false,
  onChange,
  options,
  value,
}: {
  readonly accessibilityLabel: string;
  /** Fills its row, the segments sharing the width equally; off, it takes its content's width. */
  readonly grow?: boolean;
  readonly onChange: (value: T) => void;
  readonly options: ReadonlyArray<SegmentedOption<T>>;
  readonly value: T;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="tablist"
      style={[styles.track, grow ? styles.trackGrow : styles.trackFit]}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: option.disabled === true, selected: active }}
            disabled={option.disabled}
            key={option.value}
            onPress={() => onChange(option.value)}
            style={[
              styles.segment,
              grow && styles.segmentGrow,
              active && styles.segmentActive,
              option.disabled && styles.disabled,
            ]}
            testID={option.testID}
          >
            <Text
              maxFontSizeMultiplier={BOX_FONT_SCALE}
              style={[styles.label, active && styles.labelActive]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    disabled: {
      opacity: 0.4,
    },
    label: {
      color: colors['text-secondary'],
      fontSize: 13,
      fontWeight: '500',
    },
    labelActive: {
      color: colors.text,
      fontWeight: '600',
    },
    segment: {
      alignItems: 'center',
      borderRadius: 7,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    segmentActive: {
      backgroundColor: colors.surface,
      shadowColor: '#000000',
      shadowOffset: { height: 1, width: 0 },
      shadowOpacity: 0.08,
      shadowRadius: 2,
    },
    segmentGrow: {
      flex: 1,
    },
    track: {
      backgroundColor: colors.fill,
      borderRadius: 9,
      flexDirection: 'row',
      padding: 2,
    },
    trackFit: {
      alignSelf: 'flex-start',
    },
    trackGrow: {
      flex: 1,
    },
  });
