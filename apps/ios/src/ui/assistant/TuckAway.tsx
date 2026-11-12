/* eslint-disable react/immutability -- Reanimated shared values are mutable
   refs by design (`.value =` is the API); the React Compiler lint cannot tell
   them from hook state. */
import { type ReactNode, useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

/** How long the pills take to leave and to come back. */
const TUCK_MS = 180;
/** How far down they slide as they fade. */
const TUCK_SLIDE = 16;

/**
 * What floats over the form's bottom edge, able to get out of the way
 * (`pillTuck.ts` says when): tucked, it fades and slides down a little,
 * takes no touch — what is under it does — and is out of VoiceOver's
 * reach. It fills its parent and lets touches through around its
 * children. Under Reduce Motion the change is at once (Reanimated's
 * default).
 */
export function TuckAway({
  children,
  tucked,
}: {
  readonly children: ReactNode;
  readonly tucked: boolean;
}) {
  const shown = useSharedValue(1);
  useEffect(() => {
    shown.value = withTiming(tucked ? 0 : 1, { duration: TUCK_MS });
  }, [shown, tucked]);
  const style = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ translateY: (1 - shown.value) * TUCK_SLIDE }],
  }));
  return (
    <Animated.View
      accessibilityElementsHidden={tucked}
      importantForAccessibility={tucked ? 'no-hide-descendants' : 'auto'}
      pointerEvents={tucked ? 'none' : 'box-none'}
      style={[StyleSheet.absoluteFill, style]}
    >
      {children}
    </Animated.View>
  );
}
