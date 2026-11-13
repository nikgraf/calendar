import { anchorOffset, type EditorView } from '@calendar/app-state';
import { useLayoutEffect, useRef, useState } from 'react';

/** How long a switch takes, and under Reduce Motion (a crossfade only). */
const SWITCH_MS = 280;
const FADE_MS = 150;
/** On-screen movement: in and out, strongly (the shared curve for moving UI). */
const MOVE = 'cubic-bezier(0.77, 0, 0.175, 1)';
/** How long past its length a switch may run before it is ended anyway (a window drawing no frames). */
const GRACE_MS = 120;

/** A switch under way: both panes are shown, the one leaving over the other, out of reach. */
export interface Flight {
  readonly from: EditorView;
  readonly to: EditorView;
}

/** The title inside a pane the form rises between (`data-switch-anchor`): its top in the window. */
const topOf = (pane: HTMLElement | null): number | undefined => {
  const rect = pane?.querySelector<HTMLElement>('[data-switch-anchor]')?.getBoundingClientRect();
  return rect === undefined || rect.height === 0 ? undefined : rect.top;
};

/**
 * The switch between the Assistant and the Form in the editor's panel,
 * the iPhone's in Web Animations: the form rises out of the newest card —
 * its title starts on the card's and rides up to its place while the form
 * fades in and the conversation fades out — and folds back into it on the
 * way back. A click on the other tab mid-way turns it round from where it
 * is. Under Reduce Motion it is a short crossfade.
 *
 * Both panes stay mounted, as before; `flight` keeps the one leaving shown
 * (absolute, inert) until the motion ends. The end comes from the
 * animations or, should the window draw no frames (a window at the back),
 * from a timer just past their length. `data-view` changes at the click;
 * `flight` says the motion is still under way (`data-switching`).
 */
export const useViewSwitch = (initial: EditorView) => {
  const [view, setView] = useState<EditorView>(initial);
  const [flight, setFlight] = useState<Flight | null>(null);
  const assistantPane = useRef<HTMLDivElement>(null);
  const formPane = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  // Measured at the click, while the pane leaving is still laid out.
  const leavingTop = useRef<number | undefined>(undefined);
  const running = useRef<{
    readonly animations: ReadonlyArray<Animation>;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  // The animations of a switch that ended, let go of once the pane that
  // left is hidden (`fill: 'forwards'` holds it at its end until then).
  const ended = useRef<ReadonlyArray<Animation>>([]);

  const settle = () => {
    const run = running.current;
    if (run === null) {
      return;
    }
    clearTimeout(run.timer);
    running.current = null;
    ended.current = run.animations;
    setFlight(null);
  };

  const flip = (to: EditorView) => {
    if (to === view) {
      return;
    }
    const run = running.current;
    if (flight !== null && run !== null) {
      // Mid-way: back from where it is, as long as it took to get there.
      for (const animation of run.animations) {
        animation.reverse();
      }
      const elapsed = Number(run.animations[0]?.currentTime ?? 0);
      clearTimeout(run.timer);
      run.timer = setTimeout(settle, elapsed + GRACE_MS);
      setFlight({ from: flight.to, to: flight.from });
      setView(to);
      return;
    }
    leavingTop.current = topOf(view === 'assistant' ? assistantPane.current : formPane.current);
    setFlight({ from: view, to });
    setView(to);
  };

  /** Straight to a view, no motion. */
  const snap = (to: EditorView) => {
    for (const animation of running.current?.animations ?? []) {
      animation.cancel();
    }
    if (running.current) {
      clearTimeout(running.current.timer);
    }
    running.current = null;
    setFlight(null);
    setView(to);
  };

  useLayoutEffect(() => {
    if (flight === null) {
      // The pane that left is hidden now: its held end can go.
      for (const animation of ended.current) {
        animation.cancel();
      }
      ended.current = [];
      return;
    }
    if (running.current !== null) {
      return;
    }
    const form = formPane.current;
    const assistant = assistantPane.current;
    if (form === null || assistant === null) {
      setFlight(null);
      return;
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const toForm = flight.to === 'form';
    const arriving = topOf(toForm ? form : assistant);
    const [card, title] = toForm ? [leavingTop.current, arriving] : [arriving, leavingTop.current];
    const rect = frame.current?.getBoundingClientRect();
    const offset = reduced
      ? 0
      : anchorOffset(card, title, rect && { bottom: rect.bottom, top: rect.top });
    const options: KeyframeAnimationOptions = {
      duration: reduced ? FADE_MS : SWITCH_MS,
      easing: reduced ? 'ease-out' : MOVE,
      fill: 'forwards',
    };
    const formFrames = [
      { opacity: 0, transform: `translateY(${String(offset)}px)` },
      { opacity: 1, transform: 'translateY(0)' },
    ];
    const assistantFrames = [{ opacity: 1 }, { opacity: 0 }];
    const animations = [
      form.animate(toForm ? formFrames : formFrames.toReversed(), options),
      assistant.animate(toForm ? assistantFrames : assistantFrames.toReversed(), options),
    ];
    running.current = {
      animations,
      timer: setTimeout(settle, Number(options.duration) + GRACE_MS),
    };
    // A reversed run finishes too, back at its start: either end settles.
    void Promise.all(animations.map((animation) => animation.finished)).then(settle, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a flight is handled once, when it starts
  }, [flight]);

  return { assistantPane, flight, flip, formPane, frame, snap, view };
};
