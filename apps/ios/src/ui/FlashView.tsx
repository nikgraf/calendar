/* eslint-disable react/immutability -- Reanimated shared values are mutable
   refs by design (`.value =` is the API); the React Compiler lint cannot tell
   them from hook state. */
import {
  type FlashField,
  type StepMarks,
  TURN_FLASH_FADE_MS,
  TURN_FLASH_HOLD_MS,
} from '@calendar/app-state';
import { createContext, type ReactNode, useContext, useEffect } from 'react';
import { type StyleProp, View, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from './theme.ts';

/** What the editor's form marks (`useThreadEditor().marks`): the fields the step on show changed. */
export const FieldFlashContext = createContext<StepMarks | null>(null);

/** How long a lasting mark takes to come up, and to go. */
const MARK_MS = 160;

/**
 * A row something just changed: a tint in the `highlight` color behind
 * it, nothing while `flash` is null. Fleeting — the way Settings flashes
 * the row a link lands on — it is held for `TURN_FLASH_HOLD_MS` and then
 * eased out over `TURN_FLASH_FADE_MS`, once per key. `lasting` (the
 * fields the editor's step on show changed) it comes up and stays until
 * the key is null. A color fade, not movement: Reduce Motion keeps it
 * (`ReduceMotion.Never`). The tint reaches `bleedX`/`bleedY` past the row
 * (an open row, a picker) or, with none, fills a box whose own background
 * the row's `style` draws (a text field moved into it).
 */
export function FlashView({
  bleedX = 8,
  bleedY = 4,
  children,
  flash,
  lasting = false,
  radius = 10,
  style,
  testID,
}: {
  bleedX?: number;
  bleedY?: number;
  children: ReactNode;
  flash: string | null;
  /** Stays while `flash` is set, instead of fading back. */
  lasting?: boolean;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string | undefined;
}) {
  const { colors } = useTheme();
  const opacity = useSharedValue(0);
  useEffect(() => {
    if (lasting) {
      opacity.value = withTiming(flash === null ? 0 : 1, {
        duration: MARK_MS,
        reduceMotion: ReduceMotion.Never,
      });
      return;
    }
    if (flash !== null) {
      opacity.value = withSequence(
        ReduceMotion.Never,
        withTiming(1, { duration: 0 }),
        // Held at full, then the fade.
        withTiming(1, { duration: TURN_FLASH_HOLD_MS }),
        withTiming(0, { duration: TURN_FLASH_FADE_MS, easing: Easing.inOut(Easing.quad) }),
      );
    }
  }, [flash, lasting, opacity]);
  const tint = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <View style={style} testID={testID}>
      <Animated.View
        pointerEvents="none"
        style={[
          {
            backgroundColor: colors.highlight,
            borderRadius: radius,
            bottom: -bleedY,
            left: -bleedX,
            position: 'absolute',
            right: -bleedX,
            top: -bleedY,
          },
          tint,
        ]}
      />
      {children}
    </View>
  );
}

/** A `FlashView` that stays marked while the editor's step on show changed `field` (null: never). */
export function FieldFlash({
  field,
  ...rest
}: Omit<Parameters<typeof FlashView>[0], 'flash'> & { field: FlashField | null }) {
  const marks = useContext(FieldFlashContext);
  return (
    <FlashView
      flash={marks && field !== null && marks.fields.has(field) ? marks.key : null}
      lasting
      {...rest}
    />
  );
}
