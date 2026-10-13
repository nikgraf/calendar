/* eslint-disable react/immutability -- Reanimated shared values are mutable
   refs by design (`.value =` is the API); the React Compiler lint cannot tell
   them from hook state. */
import {
  type DraftField,
  type DraftFlash,
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

/** The editor's flash (`useThreadEditor().flash`), for its form's rows. */
export const FieldFlashContext = createContext<DraftFlash | null>(null);

/**
 * A row a turn just changed: a tint in the `highlight` color behind it,
 * held for `TURN_FLASH_HOLD_MS` and then eased out over
 * `TURN_FLASH_FADE_MS` — once per `flash` key (a turn's id), nothing
 * while it is null — the way Settings flashes the row a link lands on. A color fade, not movement: Reduce Motion keeps it
 * (`ReduceMotion.Never`). The tint reaches `bleedX`/`bleedY` past the row
 * (an open row, a picker) or, with none, fills a box whose own background
 * the row's `style` draws (a text field moved into it).
 */
export function FlashView({
  bleedX = 8,
  bleedY = 4,
  children,
  flash,
  radius = 10,
  style,
  testID,
}: {
  bleedX?: number;
  bleedY?: number;
  children: ReactNode;
  flash: string | null;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string | undefined;
}) {
  const { colors } = useTheme();
  const opacity = useSharedValue(0);
  useEffect(() => {
    if (flash !== null) {
      opacity.value = withSequence(
        ReduceMotion.Never,
        withTiming(1, { duration: 0 }),
        // Held at full, then the fade.
        withTiming(1, { duration: TURN_FLASH_HOLD_MS }),
        withTiming(0, { duration: TURN_FLASH_FADE_MS, easing: Easing.inOut(Easing.quad) }),
      );
    }
  }, [flash, opacity]);
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

/** A `FlashView` that flashes when the editor's last turn changed `field` (null: never). */
export function FieldFlash({
  field,
  ...rest
}: Omit<Parameters<typeof FlashView>[0], 'flash'> & { field: DraftField | null }) {
  const flash = useContext(FieldFlashContext);
  return (
    <FlashView
      flash={flash && field !== null && flash.fields.has(field) ? flash.key : null}
      {...rest}
    />
  );
}
