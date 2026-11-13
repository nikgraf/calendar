/** The editor's two views of one draft: the conversation, and the fields. */
export type EditorView = 'assistant' | 'form';

/**
 * Where the switch between the two views stands: at rest on one (only it
 * is mounted), or under way from one to the other (both are, the one
 * leaving out of touch and out of VoiceOver's reach).
 */
export type ViewSwitch =
  | { readonly from: EditorView; readonly kind: 'flight'; readonly to: EditorView }
  | { readonly kind: 'rest'; readonly view: EditorView };

export type ViewSwitchEvent =
  /** A tap on the way to a view. */
  | { readonly to: EditorView; readonly type: 'flip' }
  /** The motion reached `view`: a stale end (a flight turned round meanwhile) changes nothing. */
  | { readonly type: 'settled'; readonly view: EditorView }
  /** Straight to a view, no motion (the model not ready as the editor opens). */
  | { readonly to: EditorView; readonly type: 'snap' };

/**
 * The switch after an event. A tap toward the view a flight came from
 * turns it round from where it is; one toward where it is going changes
 * nothing.
 */
export const viewSwitchAfter = (state: ViewSwitch, event: ViewSwitchEvent): ViewSwitch => {
  switch (event.type) {
    case 'flip':
      if (state.kind === 'rest') {
        return state.view === event.to ? state : { from: state.view, kind: 'flight', to: event.to };
      }
      return state.to === event.to ? state : { from: state.to, kind: 'flight', to: state.from };
    case 'settled':
      return state.kind === 'flight' && state.to === event.view
        ? { kind: 'rest', view: event.view }
        : state;
    case 'snap':
      return { kind: 'rest', view: event.to };
  }
};

/** The view the editor is on, or on its way to. */
export const viewShown = (state: ViewSwitch): EditorView =>
  state.kind === 'rest' ? state.view : state.to;

/** Whether `view` is mounted: the one at rest, or either end of a flight. */
export const viewMounted = (state: ViewSwitch, view: EditorView): boolean =>
  state.kind === 'rest' ? state.view === view : state.from === view || state.to === view;

/** How far below its place the form starts when there is no card to rise from. */
export const PLAIN_RISE = 24;

/** A box's top and height, in the window. */
export interface Span {
  readonly height: number;
  readonly top: number;
}

/**
 * Where a row's top will be once its conversation is at its end (it goes
 * there as it comes in, after it is first measured): the row's place in
 * the content, less what is left to scroll. Whatever the conversation is
 * scrolled to now; without the boxes, where it is.
 */
export const topAtEnd = (
  top: number | undefined,
  content: Span | undefined,
  viewport: Span | undefined,
): number | undefined =>
  top === undefined || content === undefined || viewport === undefined
    ? top
    : viewport.top + (top - content.top) - Math.max(0, content.height - viewport.height);

/**
 * How long a motion turned round has left to run: what it played so far
 * when it now runs back, what it had left when it runs forward again.
 */
export const leftAfterTurn = (current: number, backwards: boolean, duration: number): number =>
  Math.max(0, backwards ? current : duration - current);

/**
 * How far below its place the form starts so that its title sits on the
 * card's (the form rises out of the card, and folds back into it): the
 * card title's top minus the form title's, both in the window. Without
 * both, or with the card's title out of sight (`visible`, the
 * conversation's own frame), the form rises a little from nowhere in
 * particular.
 */
export const anchorOffset = (
  card: number | undefined,
  form: number | undefined,
  visible: { readonly bottom: number; readonly top: number } | undefined,
): number =>
  card === undefined ||
  form === undefined ||
  visible === undefined ||
  card < visible.top ||
  card > visible.bottom ||
  card <= form
    ? PLAIN_RISE
    : card - form;
