import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

/** How long a wait lasts before it shows: one that ends sooner never draws the spinner. */
const SHOW_AFTER_MS = 300;

// A fade is what Reduce Motion asks for in place of movement, so it runs
// then too (Reanimated would otherwise skip the delay and the fade both).
const FADE_IN = {
  duration: 250,
  easing: Easing.out(Easing.quad),
  reduceMotion: ReduceMotion.Never,
};

/**
 * A spinner for a wait that is usually short, centred in what it fills:
 * nothing for the first 300 ms, then faded in.
 */
export function DelayedSpinner() {
  const opacity = useSharedValue(0);
  useEffect(() => {
    opacity.set(withDelay(SHOW_AFTER_MS, withTiming(1, FADE_IN), ReduceMotion.Never));
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return (
    <Animated.View pointerEvents="none" style={[styles.center, style]} testID="delayed-spinner">
      <ActivityIndicator />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
});
