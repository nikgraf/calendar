import type { EditorView } from '@calendar/app-state';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  interpolateColor,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from '../theme.ts';

/** The capsule's width in the Assistant's bar: Type's, so the microphone sits in the middle. */
export const BAR_CAPSULE_WIDTH = 104;
/** How far its centre sits above the form's pills while in the bar (the bar's row is taller). */
export const BAR_LIFT = 16;
/** How long it takes to leave and come back (the keyboard up, the form scrolled down). */
const SHOW_MS = 180;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * The way between the two views, one control at the bottom right that
 * stays put while the switch runs and changes its word: "Form" in the
 * Assistant's bar, "Assistant" over the form (in the microphone's red
 * while dictation goes on behind it). Its plate grows from the bar's
 * capsule to the pill and rides the bar's few points down; the two
 * labels cross on `progress` (0: the Assistant, 1: the Form). It leaves
 * where the views have no room for it (`shown`): the keyboard up, the
 * Assistant's field open, the form scrolled down. Its id names where it
 * goes, as the two buttons it replaces did.
 */
export function SwitchCapsule({
  bottom,
  listening,
  onPress,
  progress,
  shown,
  target,
}: {
  /** How far above the sheet's bottom edge it sits over the form. */
  readonly bottom: number;
  /** Dictation is still listening behind the form. */
  readonly listening: boolean;
  readonly onPress: () => void;
  readonly progress: SharedValue<number>;
  readonly shown: boolean;
  /** Where a tap goes: the view not on show (or not on its way). */
  readonly target: EditorView;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  // The pill's own width, from its label as laid out (Dynamic Type).
  const [pillWidth, setPillWidth] = useState(132);
  const visible = useSharedValue(shown ? 1 : 0);
  useEffect(() => {
    visible.set(withTiming(shown ? 1 : 0, { duration: SHOW_MS }));
  }, [shown, visible]);
  const ground = listening ? colors.danger : colors['surface-raised'];
  const plate = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.get(), [0, 1], [colors.surface, ground]),
    opacity: visible.get(),
    // The bar's quiet shadow in the bar, the floating pill's over the form.
    shadowOffset: { height: interpolate(progress.get(), [0, 1], [2, 6]), width: 0 },
    shadowOpacity: interpolate(progress.get(), [0, 1], [0.1, 0.18]),
    shadowRadius: interpolate(progress.get(), [0, 1], [8, 18]),
    transform: [{ translateY: -BAR_LIFT * (1 - progress.get()) + (1 - visible.get()) * BAR_LIFT }],
    width: interpolate(progress.get(), [0, 1], [BAR_CAPSULE_WIDTH, pillWidth], Extrapolation.CLAMP),
  }));
  const formLabel = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0, 0.5], [1, 0], Extrapolation.CLAMP),
  }));
  const assistantLabel = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0.5, 1], [0, 1], Extrapolation.CLAMP),
  }));
  const going = target === 'form';
  return (
    <AnimatedPressable
      accessibilityElementsHidden={!shown}
      accessibilityLabel={going ? 'Form' : listening ? 'Assistant, listening' : 'Assistant'}
      accessibilityRole="button"
      importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
      onPress={onPress}
      pointerEvents={shown ? 'auto' : 'none'}
      style={[styles.plate, { bottom }, plate]}
      testID={going ? 'editor-view-form' : 'editor-view-assistant'}
    >
      <Animated.View style={[styles.label, { width: BAR_CAPSULE_WIDTH }, formLabel]}>
        <SymbolView name="rectangle.grid.1x2" size={17} tintColor={colors.text} weight="medium" />
        <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.text}>
          Form
        </Text>
      </Animated.View>
      <Animated.View
        onLayout={(event) => setPillWidth(Math.ceil(event.nativeEvent.layout.width))}
        style={[styles.label, styles.pillLabel, assistantLabel]}
      >
        <SymbolView
          name={listening ? 'mic.fill' : 'mic'}
          size={17}
          tintColor={listening ? colors['on-danger'] : colors.text}
          weight="medium"
        />
        <Text
          maxFontSizeMultiplier={BOX_FONT_SCALE}
          style={[styles.text, listening && styles.textListening]}
        >
          Assistant
        </Text>
      </Animated.View>
    </AnimatedPressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    /** A label row laid over the plate from its right edge, centred in its own width. */
    label: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
      height: 44,
      justifyContent: 'center',
      position: 'absolute',
      right: 0,
      top: 0,
    },
    pillLabel: {
      paddingLeft: 14,
      paddingRight: 18,
    },
    plate: {
      borderRadius: 22,
      height: 44,
      position: 'absolute',
      right: 28,
      shadowColor: '#000000',
    },
    text: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
    },
    textListening: {
      color: colors['on-danger'],
    },
  });
