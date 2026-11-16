import type { OptionLabel } from '@calendar/app-state';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from '../theme.ts';

/**
 * One answer, a full-width row: what it is over what tells it apart,
 * and "Taken" on the one the draft holds now. A place leads with its
 * pin's number on the map above (`lead`); the text as said, which has
 * no pin, with an empty dashed one.
 */
export function QuestionOption({
  disabled,
  label,
  lead,
  onPress,
  selected,
  testID,
}: {
  readonly disabled: boolean;
  readonly label: OptionLabel;
  readonly lead?: number | 'none' | undefined;
  readonly onPress: () => void;
  readonly selected: boolean;
  readonly testID: string;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityHint={label.detail || undefined}
      accessibilityLabel={label.title}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.option, pressed && styles.pressed, disabled && styles.off]}
      testID={testID}
    >
      {lead === 'none' ? <View style={styles.leadNone} /> : null}
      {typeof lead === 'number' ? (
        <View style={styles.lead}>
          <Text maxFontSizeMultiplier={1} style={styles.leadLabel}>
            {lead}
          </Text>
        </View>
      ) : null}
      <View style={styles.optionText}>
        <Text maxFontSizeMultiplier={BOX_FONT_SCALE} numberOfLines={2} style={styles.title}>
          {label.title}
        </Text>
        {label.detail ? (
          <Text maxFontSizeMultiplier={BOX_FONT_SCALE} numberOfLines={1} style={styles.detail}>
            {label.detail}
          </Text>
        ) : null}
      </View>
      {selected ? (
        <View style={styles.taken}>
          <SymbolView name="checkmark" size={13} tintColor={colors.text} weight="semibold" />
          <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.takenLabel}>
            Taken
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    detail: {
      color: colors['text-secondary'],
      fontSize: 13,
      lineHeight: 17,
    },
    lead: {
      alignItems: 'center',
      backgroundColor: colors.primary,
      borderRadius: 12,
      height: 24,
      justifyContent: 'center',
      width: 24,
    },
    leadLabel: {
      color: colors['on-primary'],
      fontSize: 13,
      fontVariant: ['tabular-nums'],
      fontWeight: '700',
    },
    leadNone: {
      borderColor: colors['border-strong'],
      borderRadius: 12,
      borderStyle: 'dashed',
      borderWidth: 1.5,
      height: 24,
      width: 24,
    },
    off: {
      opacity: 0.35,
    },
    option: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 12,
      minHeight: 52,
      paddingHorizontal: 12,
      paddingVertical: 7,
    },
    optionText: {
      flex: 1,
      gap: 1,
    },
    pressed: {
      opacity: 0.7,
    },
    taken: {
      alignItems: 'center',
      flexDirection: 'row',
      flexShrink: 0,
      gap: 4,
    },
    takenLabel: {
      color: colors.text,
      fontSize: 13,
      fontWeight: '600',
    },
    title: {
      color: colors.text,
      fontSize: 16,
      fontWeight: '600',
      lineHeight: 21,
    },
  });
