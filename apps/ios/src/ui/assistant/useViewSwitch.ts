import { createContext, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { type HostInstance, Keyboard } from 'react-native';
import {
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { anchorOffset, type EditorView, viewSwitchAfter } from '@calendar/app-state';

/** How long a switch takes, and under Reduce Motion (a crossfade only). */
const SWITCH_MS = 280;
const FADE_MS = 150;
/** On-screen movement: in and out, strongly (the shared curve for moving UI). */
const MOVE = Easing.bezier(0.77, 0, 0.175, 1);

/**
 * The two titles the form rises between: the newest card's, in the
 * Assistant, and the form's own title field. The card and the forms take
 * their ref from here; outside the editor's route there is none.
 */
export interface SwitchAnchors {
  readonly card: (element: HostInstance | null) => void;
  readonly form: (element: HostInstance | null) => void;
}

export const SwitchAnchorContext = createContext<SwitchAnchors | null>(null);

/** An element's top in the window, as laid out (transforms included), if it is there. */
const topOf = (element: HostInstance | null): number | undefined => {
  const rect = element?.getBoundingClientRect();
  return rect === undefined || rect.height === 0 ? undefined : rect.y;
};

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
  const progress = useSharedValue(initial === 'form' ? 1 : 0);
  // How far below its place the form's content sits at the Assistant's end.
  const offset = useSharedValue(0);
  const card = useRef<HostInstance | null>(null);
  const form = useRef<HostInstance | null>(null);
  const anchors: SwitchAnchors = {
    card: (element) => {
      card.current = element;
    },
    form: (element) => {
      form.current = element;
    },
  };
  const frame = useRef<HostInstance | null>(null);
  // Measured at the tap, read once the other view has laid out.
  const leaving = useRef<{ readonly plain: boolean; readonly top: number | undefined }>({
    plain: false,
    top: undefined,
  });
  // The flight under way, from the first frame on; none at rest.
  const running = useRef<string | undefined>(undefined);
  // The form a flip mounts does not take the focus: the keyboard would
  // rise under the motion.
  const [flipped, setFlipped] = useState(false);

  const flip = (to: EditorView) => {
    if (state.kind === 'rest' && state.view !== to) {
      leaving.current = {
        // With the keyboard up the views change size as it goes: no anchor holds.
        plain: reduced || Keyboard.isVisible(),
        top: topOf(to === 'form' ? card.current : form.current),
      };
      setFlipped(true);
    }
    dispatch({ to, type: 'flip' });
  };

  const settle = (view: EditorView) => {
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
      const arriving = topOf(state.to === 'form' ? form.current : card.current);
      const rect = frame.current?.getBoundingClientRect();
      const [cardTop, formTop] = state.to === 'form' ? [top, arriving] : [arriving, top];
      offset.set(
        plain
          ? 0
          : anchorOffset(cardTop, formTop, rect && { bottom: rect.y + rect.height, top: rect.y }),
      );
    }
    running.current = flight;
    const plain = leaving.current.plain;
    const left = Math.abs(target - progress.get());
    const to = state.to;
    progress.set(
      withTiming(
        target,
        {
          duration: Math.max(60, Math.round((plain ? FADE_MS : SWITCH_MS) * left)),
          easing: plain ? Easing.out(Easing.quad) : MOVE,
        },
        (finished) => {
          'worklet';
          if (finished) {
            scheduleOnRN(settle, to);
          }
        },
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a flight is handled once, when it starts or turns round
  }, [flight]);

  // The conversation goes first, the form comes in behind it.
  const assistantStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0, 0.6], [1, 0], Extrapolation.CLAMP),
  }));
  const formStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0.2, 0.9], [0, 1], Extrapolation.CLAMP),
  }));
  // The fields ride; what floats over them (the pills) stays put.
  const formContentStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.get() * (1 - progress.get()) }],
  }));

  return {
    anchors,
    assistantStyle,
    flip,
    /** The form came by a flip: its title does not take the focus. */
    flipped,
    formContentStyle,
    formStyle,
    /** The frame both views fill: the card's title counts only while it is inside it. */
    frame,
    snap,
    state,
  };
};
