/* eslint-disable react/immutability -- Reanimated shared values are mutable
   refs by design (`.value =` is the API); the React Compiler lint cannot tell
   them from hook state. */
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef } from 'react';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { chipTextColor, useTheme } from './theme.ts';

/** Box diameter, ring width and checkmark size per place. */
const SIZES = {
  agenda: { box: 20, check: 11, ring: 1.5 },
  chip: { box: 16, check: 9, ring: 1.5 },
  list: { box: 24, check: 13, ring: 1.75 },
} as const;

/**
 * The task checkbox's look: a ring that fills with a checkmark when done.
 * A Reminders list's color stands in for the neutral ring and the primary
 * fill (so a chip needs no separate list dot), and an open overdue task
 * rings in the danger color. It draws only; the caller's Pressable owns
 * the tap, its label and hit area, and hands its `pressed` state in. The
 * box shrinks while pressed and pops when it becomes done — on the change
 * only, never when a done row mounts.
 */
export function TaskCheck({
  checked,
  disabled = false,
  listColor,
  overdue = false,
  pressed = false,
  size,
}: {
  checked: boolean;
  /** A read-only list: the box dims. */
  disabled?: boolean;
  listColor?: string | undefined;
  overdue?: boolean;
  pressed?: boolean;
  size: keyof typeof SIZES;
}) {
  const { colors, scheme } = useTheme();
  const { box, check, ring } = SIZES[size];
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const wasChecked = useRef(checked);

  // The press first, so a release and a completion landing in one commit
  // end on the pop.
  useEffect(() => {
    if (!reduceMotion) {
      scale.value = withTiming(pressed ? 0.86 : 1, { duration: 100 });
    }
  }, [pressed, reduceMotion, scale]);
  useEffect(() => {
    if (checked && !wasChecked.current && !reduceMotion) {
      scale.value = withSequence(
        withTiming(0.8, { duration: 0 }),
        withSpring(1, { damping: 9, mass: 0.5, stiffness: 320 }),
      );
    }
    wasChecked.current = checked;
  }, [checked, reduceMotion, scale]);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const fill = listColor ?? colors.primary;
  const well = scheme === 'dark' ? colors.canvas : colors.surface;
  const ringColor = overdue && !checked ? colors.danger : (listColor ?? colors['border-strong']);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          alignItems: 'center',
          backgroundColor: checked ? fill : well,
          borderColor: checked ? fill : ringColor,
          borderRadius: box / 2,
          borderWidth: ring,
          height: box,
          justifyContent: 'center',
          opacity: disabled ? 0.45 : 1,
          width: box,
        },
        animated,
      ]}
    >
      {checked ? (
        <SymbolView
          name="checkmark"
          size={check}
          tintColor={listColor ? chipTextColor(listColor) : colors['on-primary']}
          weight="bold"
        />
      ) : null}
    </Animated.View>
  );
}
