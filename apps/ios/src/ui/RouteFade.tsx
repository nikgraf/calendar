import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Keyboard, StyleSheet, View, type ViewInstance } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { type Fade, type FadeEvent, fadeStep } from './routeFadeState.ts';

// A fade is what Reduce Motion asks for in place of movement, so it runs
// then too (Reanimated would otherwise cut straight to the end). The old
// content leaves quicker than the new arrives, so the two never read as one.
const FADE_IN = {
  duration: 250,
  easing: Easing.out(Easing.quad),
  reduceMotion: ReduceMotion.Never,
};
const FADE_OUT = {
  duration: 150,
  easing: Easing.out(Easing.quad),
  reduceMotion: ReduceMotion.Never,
};

/**
 * What a layer is doing: `arriving` mounted and not drawn yet, `in`
 * fading in, `rest` on screen alone; `leaving` still whole while the new
 * one is laid out, `out` fading out.
 */
type Role = 'arriving' | 'in' | 'leaving' | 'out' | 'rest';

function Layer<T>({
  children,
  contentKey,
  dispatch,
  role,
}: {
  readonly children: ReactNode;
  readonly contentKey: string;
  readonly dispatch: (event: FadeEvent<T>) => void;
  readonly role: Role;
}) {
  const opacity = useSharedValue(role === 'arriving' ? 0 : 1);
  const content = useRef<ViewInstance>(null);
  useEffect(() => {
    if (role === 'in') {
      const arrived = () => {
        // What VoiceOver was on went with the old content: it moves to the
        // new one's first element, as it would into a new sheet — once the
        // content is drawn whole, not while it is still transparent.
        if (content.current) {
          AccessibilityInfo.sendAccessibilityEvent(content.current, 'focus');
        }
        dispatch({ key: contentKey, kind: 'faded' });
      };
      opacity.set(
        withTiming(1, FADE_IN, (finished) => {
          'worklet';
          if (finished) {
            scheduleOnRN(arrived);
          }
        }),
      );
    } else if (role === 'out') {
      opacity.set(withTiming(0, FADE_OUT));
    } else if (role !== 'arriving') {
      // On screen alone, or the one to fade from while the next is laid
      // out: whole again, from wherever a swap it was in had left it.
      opacity.set(withTiming(1, FADE_IN));
    }
  }, [contentKey, dispatch, opacity, role]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  const leaving = role === 'leaving' || role === 'out';
  return (
    <Animated.View
      // The one leaving is neither tapped nor read out: the new one is what is there.
      accessibilityElementsHidden={leaving}
      importantForAccessibility={leaving ? 'no-hide-descendants' : 'auto'}
      // Laid out, and a frame drawn after: the main thread is free again,
      // so the fade's frames are all drawn.
      onLayout={
        role === 'arriving'
          ? () => requestAnimationFrame(() => dispatch({ key: contentKey, kind: 'ready' }))
          : undefined
      }
      pointerEvents={leaving ? 'none' : 'auto'}
      style={[StyleSheet.absoluteFill, style]}
    >
      <View collapsable={false} ref={content} style={styles.content}>
        {children}
      </View>
    </Animated.View>
  );
}

/**
 * The editor route's content changing while its sheet stays up — the
 * detail turning into its editor on Edit and back on Cancel, or a tapped
 * reminder's event over an editor: the old fades out as the new fades
 * in, as Contacts' Edit does (`routeFadeState.ts`). A new `keyOf` is a
 * change; the same key updates the content in place. Nothing fades as
 * the route opens: the sheet slides in with its content.
 */
export function RouteFade<T>({
  item,
  keyOf,
  render,
}: {
  readonly item: T;
  readonly keyOf: (item: T) => string;
  readonly render: (item: T) => ReactNode;
}) {
  const [fade, setFade] = useState<Fade<T>>({ kind: 'still', shown: item });
  // Render-phase state adjustment (React's "derive from props" pattern).
  if (item !== fade.shown) {
    setFade(fadeStep(fade, { item, kind: 'item' }, keyOf));
  }
  const dispatch = useCallback(
    (event: FadeEvent<T>) => setFade((current) => fadeStep(current, event, keyOf)),
    [keyOf],
  );
  // The content leaving takes its keyboard along, rather than leaving it
  // up over the new one until it has gone: when a swap starts, turns round
  // or a third content comes. Not when the new one is drawn, so a field
  // it focuses on its own keeps the keyboard.
  const leavingKey = fade.kind === 'still' ? null : keyOf(fade.leaving);
  useEffect(() => {
    if (leavingKey !== null) {
      Keyboard.dismiss();
    }
  }, [leavingKey]);
  return (
    <>
      {fade.kind === 'still' ? null : (
        <Layer
          contentKey={keyOf(fade.leaving)}
          dispatch={dispatch}
          key={keyOf(fade.leaving)}
          role={fade.kind === 'waiting' ? 'leaving' : 'out'}
        >
          {render(fade.leaving)}
        </Layer>
      )}
      <Layer
        contentKey={keyOf(fade.shown)}
        dispatch={dispatch}
        key={keyOf(fade.shown)}
        role={fade.kind === 'still' ? 'rest' : fade.kind === 'waiting' ? 'arriving' : 'in'}
      >
        {render(fade.shown)}
      </Layer>
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
  },
});
