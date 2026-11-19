/**
 * The editor route's content as it changes in place (`RouteFade`): the
 * detail turning into its editor, back on Cancel, a tapped reminder's
 * event over an editor. The content that was on screen stays, whole and
 * live, until the new one has been laid out — mounting the editor takes
 * the main thread for a while, and a fade started with the mount would
 * be over before a frame of it is drawn — then the two cross-fade.
 *
 * `still`: one content on screen. `waiting`: the new one is mounted,
 * not yet drawn, over the one leaving, which is still whole. `fading`:
 * the new fades in as the one leaving fades out.
 */
export type Fade<T> =
  | { readonly kind: 'still'; readonly shown: T }
  | { readonly kind: 'waiting'; readonly leaving: T; readonly shown: T }
  | { readonly kind: 'fading'; readonly leaving: T; readonly shown: T };

export type FadeEvent<T> =
  /** The content to show now: the same key updates it, a new one swaps. */
  | { readonly item: T; readonly kind: 'item' }
  /** The content of this key has been laid out: the fade may start. */
  | { readonly key: string; readonly kind: 'ready' }
  /** The content of this key has faded in. */
  | { readonly key: string; readonly kind: 'faded' };

export const fadeStep = <T>(
  state: Fade<T>,
  event: FadeEvent<T>,
  keyOf: (item: T) => string,
): Fade<T> => {
  const shownKey = keyOf(state.shown);
  if (event.kind === 'ready') {
    return state.kind === 'waiting' && event.key === shownKey
      ? { kind: 'fading', leaving: state.leaving, shown: state.shown }
      : state;
  }
  if (event.kind === 'faded') {
    return state.kind === 'fading' && event.key === shownKey
      ? { kind: 'still', shown: state.shown }
      : state;
  }
  const key = keyOf(event.item);
  if (key === shownKey) {
    return { ...state, shown: event.item };
  }
  // Back to the content still leaving (Edit, then Cancel): before the new
  // one was drawn it simply stays; mid-fade the fade turns round.
  if (state.kind !== 'still' && key === keyOf(state.leaving)) {
    return state.kind === 'waiting'
      ? { kind: 'still', shown: event.item }
      : { kind: 'fading', leaving: state.shown, shown: event.item };
  }
  // While waiting, the one leaving is what is on screen, so it stays the
  // one to fade from, and the one that never showed goes. Otherwise the
  // one shown leaves.
  return {
    kind: 'waiting',
    leaving: state.kind === 'waiting' ? state.leaving : state.shown,
    shown: event.item,
  };
};
