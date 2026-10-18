import { Pressable, StyleSheet, Text } from 'react-native';
import { type ThemeColors, useStyles } from './theme.ts';

/**
 * A choice as a capsule: soft-filled, filled ink (`primary`) once selected — the
 * editor's repeat, notification, priority and alert choices, the finder's
 * presets, a birthday's lead days. The selection is reported through
 * `accessibilityState`, which Maestro asserts; `testID` is the flows'
 * handle.
 */
export function Chip({
  disabled = false,
  label,
  onPress,
  selected,
  testID,
}: {
  disabled?: boolean | undefined;
  label: string;
  onPress: () => void;
  selected: boolean;
  testID?: string | undefined;
}) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.selected,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      <Text style={[styles.label, selected && styles.labelSelected]}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    chip: {
      backgroundColor: colors.fill,
      borderRadius: 999,
      justifyContent: 'center',
      minHeight: 34,
      paddingHorizontal: 14,
      paddingVertical: 6,
    },
    disabled: {
      opacity: 0.4,
    },
    label: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '500',
    },
    labelSelected: {
      color: colors['on-primary'],
      fontWeight: '600',
    },
    pressed: {
      opacity: 0.7,
    },
    selected: {
      backgroundColor: colors.primary,
    },
  });
