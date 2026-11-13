import { createContext, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { type HostInstance, type ScrollViewInstance, useWindowDimensions } from 'react-native';
import {
  Easing,
  Extrapolation,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { BAR_LIFT } from './SwitchCapsule.tsx';
import {
  anchorOffset,
  type EditorView,
  type Span,
  topAtEnd,
  viewSwitchAfter,
} from '@calendar/app-state';

/** How long a switch takes, and under Reduce Motion (a crossfade only). */
const SWITCH_MS = 280;
const FADE_MS = 150;
/** On-screen movement: in and out, strongly (the shared curve for moving UI). */
const MOVE = Easing.bezier(0.77, 0, 0.175, 1);
/**
 * Where the capsule's microphone glyph sits, from the window's right
 * edge: the capsule's inset (28), less the pill's width (about 132), plus
 * its glyph's inset and half width (14 + 8.5). Near enough for a disc
 * that shrinks and fades on its way there.
 */
const GLYPH_FROM_RIGHT = 28 + 132 - 22.5;
/** The microphone at the capsule's glyph: a quarter of its size. */
const MIC_LANDS = 0.25;
/** Where the conversation has faded out, and the microphone has reached the capsule. */
const MIC_ARRIVES = 0.6;

/**
 * The two titles the form rises between: the newest card's, in the
 * Assistant, and the form's own title field; and the conversation the
 * card is in. The card, the conversation and the forms take their ref
 * from here; outside the editor's route there is none.
 */
export interface SwitchAnchors {
  readonly card: (element: HostInstance | null) => void;
  readonly conversation: (scroller: ScrollViewInstance | null) => void;
  readonly form: (element: HostInstance | null) => void;
}

export const SwitchAnchorContext = createContext<SwitchAnchors | null>(null);

/** An element's box in the window, as laid out (transforms included), if it is there. */
const spanOf = (element: HostInstance | null | undefined): Span | undefined => {
  const rect = element?.getBoundingClientRect();
  return rect === undefined || rect.height === 0 ? undefined : { height: rect.height, top: rect.y };
};
const topOf = (element: HostInstance | null): number | undefined => spanOf(element)?.top;

/**
 * The switch between the Assistant and the Form (`viewSwitch.ts`): the
 * form rises out of the newest card — its title starts on the card's and
 * rides up to its place while the form fades in and the conversation
 * fades out — and folds back into it on the way back. One shared value,
 * `progress`, runs from 0 (the Assistant) to 1 (the Form) on the UI
 * thread; each layer reads it (`assistantStyle`, `formStyle`,
 * `formContentStyle`). A tap mid-way turns it round from where it is.
 * Under Reduce Motion, and with the keyboard up, it is a short crossfade.
 *
 * The two titles are measured where nothing moves them: the one leaving
 * when the tap lands, the one coming in once it has laid out (a layout
 * effect, before the first frame of the motion). Nothing here sets React
 * state while it runs: the end is one `settled`, back on the JS thread.
 */
export const useViewSwitch = (initial: EditorView) => {
  const [state, dispatch] = useReducer(viewSwitchAfter, { kind: 'rest', view: initial });
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const progress = useSharedValue(initial === 'form' ? 1 : 0);
  // How far below its place the form's content sits at the Assistant's end.
  const offset = useSharedValue(0);
  const card = useRef<HostInstance | null>(null);
  const conversation = useRef<ScrollViewInstance | null>(null);
  const form = useRef<HostInstance | null>(null);
  const anchors: SwitchAnchors = {
    card: (element) => {
      card.current = element;
    },
    conversation: (scroller) => {
      conversation.current = scroller;
    },
    form: (element) => {
      form.current = element;
    },
  };
  /**
   * The card's title where it will be: the conversation comes in at its
   * start and scrolls to its end only once it has laid out, after this
   * is measured.
   */
  const cardAtEnd = () => {
    const scroller = conversation.current;
    return topAtEnd(topOf(card.current), spanOf(scroller?.getInnerViewRef()), spanOf(scroller));
  };
  const frame = useRef<HostInstance | null>(null);
  // Measured at the tap, read once the other view has laid out.
  const leaving = useRef<{ readonly plain: boolean; readonly top: number | undefined }>({
    plain: false,
    top: undefined,
  });
  // The run under way, from its first frame on (a turn round is a run of
  // its own); none at rest. Its end settles only while it is the one.
  const running = useRef<number | undefined>(undefined);
  const runs = useRef(0);
  // The form a flip mounts does not take the focus: the keyboard would
  // rise under the motion.
  const [flipped, setFlipped] = useState(false);

  /**
   * To a view. `keyboardUp`: the views change size as the keyboard goes,
   * so no anchor holds — a crossfade, as under Reduce Motion. (The
   * sheet's own measure: `Keyboard.isVisible()` stays true after XCTest's
   * typing hides the keyboard.)
   */
  const flip = (to: EditorView, keyboardUp = false) => {
    if (state.kind === 'rest' && state.view !== to) {
      leaving.current = {
        plain: reduced || keyboardUp,
        top: topOf(to === 'form' ? card.current : form.current),
      };
      setFlipped(true);
    }
    dispatch({ to, type: 'flip' });
  };

  const settle = (view: EditorView, run: number) => {
    // A run turned round meanwhile (a tap between its last frame and this): the new one goes on.
    if (running.current !== run) {
      return;
    }
    running.current = undefined;
    // At rest on the Assistant the form is gone: it comes back from where it is measured next.
    if (view === 'assistant') {
      offset.set(0);
    }
    dispatch({ type: 'settled', view });
  };

  /** Straight to a view, no motion. */
  const snap = (to: EditorView) => {
    running.current = undefined;
    progress.set(to === 'form' ? 1 : 0);
    offset.set(0);
    dispatch({ to, type: 'snap' });
  };

  // The flight under way: a turn round is another (and runs again).
  const flight = state.kind === 'flight' ? `${state.from}>${state.to}` : undefined;
  useLayoutEffect(() => {
    if (state.kind !== 'flight') {
      return;
    }
    const target = state.to === 'form' ? 1 : 0;
    if (running.current === undefined) {
      // From rest: the view coming in has laid out, unmoved (at rest on
      // the Assistant the offset is 0, and at the Form's end it is not applied).
      const { plain, top } = leaving.current;
      const arriving = state.to === 'form' ? topOf(form.current) : cardAtEnd();
      const rect = frame.current?.getBoundingClientRect();
      const [cardTop, formTop] = state.to === 'form' ? [top, arriving] : [arriving, top];
      offset.set(
        plain
          ? 0
          : anchorOffset(cardTop, formTop, rect && { bottom: rect.y + rect.height, top: rect.y }),
      );
    }
    runs.current += 1;
    const run = runs.current;
    running.current = run;
    const plain = leaving.current.plain;
    const left = Math.abs(target - progress.get());
    const to = state.to;
    progress.set(
      withTiming(
        target,
        {
          duration: Math.max(60, Math.round((plain ? FADE_MS : SWITCH_MS) * left)),
          easing: plain ? Easing.out(Easing.quad) : MOVE,
          // Reduce Motion is this hook's own (the crossfade above), not
          // Reanimated's: under it the system's setting would cut straight to the end.
          reduceMotion: ReduceMotion.Never,
        },
        (finished) => {
          'worklet';
          if (finished) {
            scheduleOnRN(settle, to, run);
          }
        },
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a flight is handled once, when it starts or turns round
  }, [flight]);

  // The conversation goes first, the form comes in behind it.
  const assistantStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0, MIC_ARRIVES], [1, 0], Extrapolation.CLAMP),
  }));
  const formStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0.2, 0.9], [0, 1], Extrapolation.CLAMP),
  }));
  // The fields ride; what floats over them (the pills) stays put.
  const formContentStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.get() * (1 - progress.get()) }],
  }));
  // The bar's microphone shrinks into the capsule's on the way to the
  // form, and grows out of it on the way back. It gets there by the time
  // its layer has faded (0.6), so the travel is seen.
  const toGlyph = width - GLYPH_FROM_RIGHT - width / 2;
  const micStyle = useAnimatedStyle(() => {
    const moved = reduced
      ? 0
      : interpolate(progress.get(), [0, MIC_ARRIVES], [0, 1], Extrapolation.CLAMP);
    return {
      transform: [
        { translateX: toGlyph * moved },
        { translateY: BAR_LIFT * moved },
        { scale: interpolate(moved, [0, 1], [1, MIC_LANDS]) },
      ],
    };
  });

  return {
    anchors,
    assistantStyle,
    flip,
    /** The form came by a flip: its title does not take the focus. */
    flipped,
    formContentStyle,
    formStyle,
    micStyle,
    /** Where the switch stands: 0 the Assistant, 1 the Form (the capsule reads it). */
    progress,
    /** The frame both views fill: the card's title counts only while it is inside it. */
    frame,
    snap,
    state,
  };
};
