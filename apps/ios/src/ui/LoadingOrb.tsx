import { useEffect } from 'react';
import { type StyleProp, StyleSheet, type TextStyle, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import {
  DOT_SIZE,
  dotLook,
  letterOpacity,
  LOOP_MS,
  ORB_DOTS,
  ORB_SIZE,
  orbDot,
  orbOpacity,
  RADIUS,
} from './loadingOrbMotion.ts';
import { type ThemeColors, useStyles, useTheme } from './theme.ts';

/** How long a wait lasts before it shows: one that ends sooner never draws the orb. */
const SHOW_AFTER_MS = 300;

// A fade is what Reduce Motion asks for in place of movement, so it runs
// then too (Reanimated would otherwise skip the delay and the fade both).
const FADE_IN = {
  duration: 250,
  easing: Easing.out(Easing.quad),
  reduceMotion: ReduceMotion.Never,
};

// Constant motion runs linear. Reduce Motion is handled by the motion
// itself (`still`), so the loop keeps running to drive the breathing.
const LOOP = {
  duration: LOOP_MS,
  easing: Easing.linear,
  reduceMotion: ReduceMotion.Never,
};

/**
 * A wait that is usually short, centred in what it fills: nothing for the
 * first 300 ms, then an orb of dots weaving on crossing rings beside a
 * label a light sweeps across, faded in. The motion is
 * `loadingOrbMotion.ts`.
 */
export function LoadingOrb({ label }: { readonly label: string }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const still = useReducedMotion();
  const shown = useSharedValue(0);
  const phase = useSharedValue(0);
  useEffect(() => {
    shown.set(withDelay(SHOW_AFTER_MS, withTiming(1, FADE_IN), ReduceMotion.Never));
    phase.set(withRepeat(withTiming(1, LOOP), -1, false, undefined, ReduceMotion.Never));
    return () => {
      cancelAnimation(phase);
    };
  }, [phase, shown]);
  const shownStyle = useAnimatedStyle(() => ({ opacity: shown.get() }));
  const orbStyle = useAnimatedStyle(() => ({ opacity: orbOpacity(phase.get(), still) }));
  // Letters by code point: a character outside the Basic Multilingual
  // Plane stays whole, which splitting the string's UTF-16 units would not.
  const letters = Array.from(label);
  return (
    <Animated.View pointerEvents="none" style={[styles.center, shownStyle]} testID="loading-orb">
      <View
        accessibilityLabel={label}
        accessibilityRole="progressbar"
        accessible
        style={styles.row}
      >
        <Animated.View style={[styles.orb, orbStyle]}>
          {ORB_DOTS.map(({ index, ring }) => (
            <Dot
              color={colors.text}
              index={index}
              key={`${ring}-${index}`}
              phase={phase}
              ring={ring}
              still={still}
            />
          ))}
        </Animated.View>
        <View style={styles.label}>
          {letters.map((letter, n) => (
            <Letter
              at={(n + 0.5) / letters.length}
              // Letters repeat; their place in the label is what is stable.
              key={n}
              letter={letter}
              phase={phase}
              still={still}
              style={styles.letter}
            />
          ))}
        </View>
      </View>
    </Animated.View>
  );
}

function Dot({
  color,
  index,
  phase,
  ring,
  still,
}: {
  readonly color: string;
  readonly index: number;
  readonly phase: SharedValue<number>;
  readonly ring: number;
  readonly still: boolean;
}) {
  const style = useAnimatedStyle(() => {
    const { depth, x, y } = orbDot(ring, index, phase.get(), still);
    const { opacity, scale } = dotLook(depth);
    return {
      opacity,
      transform: [{ translateX: x * RADIUS }, { translateY: y * RADIUS }, { scale }],
    };
  });
  return <Animated.View style={[dotStyles.dot, { backgroundColor: color }, style]} />;
}

function Letter({
  at,
  letter,
  phase,
  still,
  style,
}: {
  readonly at: number;
  readonly letter: string;
  readonly phase: SharedValue<number>;
  readonly still: boolean;
  readonly style: StyleProp<TextStyle>;
}) {
  const animated = useAnimatedStyle(() => ({ opacity: letterOpacity(at, phase.get(), still) }));
  return (
    <Animated.Text maxFontSizeMultiplier={LABEL_FONT_SCALE} style={[style, animated]}>
      {letter}
    </Animated.Text>
  );
}

/** The label is one line of letters that cannot wrap: it grows this far with Dynamic Type. */
const LABEL_FONT_SCALE = 1.6;

const dotStyles = StyleSheet.create({
  dot: {
    borderRadius: DOT_SIZE / 2,
    height: DOT_SIZE,
    left: (ORB_SIZE - DOT_SIZE) / 2,
    position: 'absolute',
    top: (ORB_SIZE - DOT_SIZE) / 2,
    width: DOT_SIZE,
  },
});

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    center: {
      alignItems: 'center',
      flex: 1,
      justifyContent: 'center',
    },
    label: {
      flexDirection: 'row',
    },
    letter: {
      color: colors.text,
      fontSize: 15,
    },
    orb: {
      height: ORB_SIZE,
      width: ORB_SIZE,
    },
    row: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 10,
    },
  });
