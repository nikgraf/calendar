import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text } from 'react-native';
import { BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from '../theme.ts';

/**
 * The way from the form back to the Assistant, floating over the form's
 * bottom right by the thumb — where the bar's Form is on the other side.
 * While dictation is still listening (it goes on behind the form until a
 * field is edited by hand), the pill says so in the microphone's red.
 */
export function ViewPill({
  bottom,
  listening,
  onPress,
}: {
  /** How far above the sheet's bottom edge it floats. */
  readonly bottom: number;
  readonly listening: boolean;
  readonly onPress: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={listening ? 'Assistant, listening' : 'Assistant'}
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.pill, { bottom }, listening && styles.listening]}
      testID="editor-view-assistant"
    >
      <SymbolView
        name={listening ? 'mic.fill' : 'mic'}
        size={17}
        tintColor={listening ? colors['on-danger'] : colors.text}
        weight="medium"
      />
      <Text
        maxFontSizeMultiplier={BOX_FONT_SCALE}
        style={[styles.label, listening && styles.labelListening]}
      >
        Assistant
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    label: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
    },
    labelListening: {
      color: colors['on-danger'],
    },
    listening: {
      backgroundColor: colors.danger,
    },
    pill: {
      alignItems: 'center',
      backgroundColor: colors['surface-raised'],
      borderRadius: 22,
      flexDirection: 'row',
      gap: 8,
      height: 44,
      paddingLeft: 14,
      paddingRight: 18,
      position: 'absolute',
      right: 28,
      shadowColor: '#000000',
      shadowOffset: { height: 6, width: 0 },
      shadowOpacity: 0.18,
      shadowRadius: 18,
    },
  });
