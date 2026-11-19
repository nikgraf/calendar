import type { useThreadEditor } from '@calendar/app-state';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from '../theme.ts';

/**
 * The way through the thread's steps, floating over the form's bottom
 * left by the thumb: one back, where it stands, one forward. Not there
 * before the first step. The desktop's footer control, with its test ids.
 */
export function StepPill({
  bottom,
  steps,
}: {
  /** How far above the sheet's bottom edge it floats. */
  readonly bottom: number;
  readonly steps: ReturnType<typeof useThreadEditor>['steps'];
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  if (steps.of === 0) {
    return null;
  }
  const noBack = steps.locked || steps.at === 0;
  const noForward = steps.locked || steps.at === steps.of;
  return (
    <View style={[styles.pill, { bottom }]} testID="step-pill">
      <Pressable
        accessibilityLabel="Step back"
        accessibilityRole="button"
        accessibilityState={{ disabled: noBack }}
        disabled={noBack}
        onPress={steps.back}
        style={[styles.arrow, noBack && styles.disabled]}
        testID="step-back"
      >
        <SymbolView name="arrow.uturn.backward" size={18} tintColor={colors.text} weight="medium" />
      </Pressable>
      <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.position} testID="step-position">
        {steps.at === 0 ? 'Start' : `${String(steps.at)} of ${String(steps.of)}`}
      </Text>
      <Pressable
        accessibilityLabel="Step forward"
        accessibilityRole="button"
        accessibilityState={{ disabled: noForward }}
        disabled={noForward}
        onPress={steps.forward}
        style={[styles.arrow, noForward && styles.disabled]}
        testID="step-forward"
      >
        <SymbolView name="arrow.uturn.forward" size={18} tintColor={colors.text} weight="medium" />
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    arrow: {
      alignItems: 'center',
      height: 44,
      justifyContent: 'center',
      width: 48,
    },
    disabled: {
      opacity: 0.3,
    },
    pill: {
      alignItems: 'center',
      backgroundColor: colors['surface-raised'],
      borderRadius: 22,
      flexDirection: 'row',
      height: 44,
      left: 28,
      position: 'absolute',
      shadowColor: '#000000',
      shadowOffset: { height: 6, width: 0 },
      shadowOpacity: 0.18,
      shadowRadius: 18,
    },
    position: {
      color: colors['text-secondary'],
      fontSize: 13,
      fontVariant: ['tabular-nums'],
      fontWeight: '600',
      minWidth: 42,
      textAlign: 'center',
    },
  });
