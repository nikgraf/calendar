import { stepName, stepSource, type useThreadEditor } from '@calendar/app-state';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BOX_FONT_SCALE, type ThemeColors, useStyles } from '../theme.ts';

/**
 * An older step on show: which one it is, in a line, and "Use this" —
 * which keeps it and lets the steps after it go. Stepping forward leaves
 * it instead. It floats over the form above the pills, and sits above
 * the Assistant's bar. The desktop's row, with its test ids.
 */
export function UseStepCard({
  bottom,
  editor,
}: {
  /** Floating over the form: how far above the sheet's bottom edge. In the flow of the Assistant, absent. */
  readonly bottom?: number | undefined;
  readonly editor: ReturnType<typeof useThreadEditor>;
}) {
  const styles = useStyles(makeStyles);
  const { assistant, steps } = editor;
  const shown = steps.line[steps.at - 1];
  return (
    <View
      style={[styles.card, bottom === undefined ? styles.inFlow : [styles.floating, { bottom }]]}
      testID="step-preview"
    >
      <View style={styles.text}>
        <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.label}>
          {shown
            ? `STEP ${String(steps.at)} OF ${String(steps.of)} · ${stepSource(shown).toUpperCase()}`
            : 'THE START'}
        </Text>
        <Text numberOfLines={1} style={styles.name} testID="step-name">
          {shown ? stepName(shown) : assistant === 'saved' ? 'As saved' : 'Nothing yet'}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: steps.locked }}
        disabled={steps.locked}
        onPress={steps.use}
        style={[styles.use, steps.locked && styles.disabled]}
        testID="step-use"
      >
        <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.useLabel}>
          Use this
        </Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      alignItems: 'center',
      backgroundColor: colors['surface-raised'],
      borderRadius: 20,
      flexDirection: 'row',
      gap: 10,
      paddingLeft: 16,
      paddingRight: 8,
      paddingVertical: 8,
      shadowColor: '#000000',
      shadowOffset: { height: 6, width: 0 },
      shadowOpacity: 0.18,
      shadowRadius: 18,
    },
    disabled: {
      opacity: 0.35,
    },
    floating: {
      left: 16,
      position: 'absolute',
      right: 16,
    },
    inFlow: {
      marginHorizontal: 16,
      marginTop: 4,
    },
    label: {
      color: colors['text-secondary'],
      fontSize: 12,
      fontWeight: '600',
      letterSpacing: 0.3,
    },
    name: {
      color: colors.text,
      fontSize: 15,
      lineHeight: 20,
    },
    text: {
      flex: 1,
      gap: 1,
    },
    use: {
      backgroundColor: colors.primary,
      borderRadius: 22,
      justifyContent: 'center',
      minHeight: 44,
      paddingHorizontal: 18,
    },
    useLabel: {
      color: colors['on-primary'],
      fontSize: 15,
      fontWeight: '600',
    },
  });
