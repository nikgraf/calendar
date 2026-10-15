/**
 * Which edges of the grid a drag may scroll: an edge arms once the pointer
 * has been in the grid clear of that edge's zone. A chip dragged down from
 * the all-day lane crosses the top zone on its way in, and a block pressed
 * near an edge starts inside its zone; neither means "scroll".
 */
export interface EdgeScrollState {
  readonly armedBottom: boolean;
  readonly armedTop: boolean;
}

/** A drag's state before its first move. */
export const EDGE_SCROLL_IDLE: EdgeScrollState = { armedBottom: false, armedTop: false };

/** The scroll speed at the very edge, in grid hours per second; each platform multiplies by its hour height. */
export const EDGE_SCROLL_HOURS_PER_SECOND = 8;

export interface EdgeScrollStep {
  readonly state: EdgeScrollState;
  /** px per second; negative scrolls toward earlier hours. */
  readonly velocity: number;
}

/**
 * How fast a drag at `y` scrolls the grid whose visible extent is
 * `viewport`: nothing in the middle, ramping up (quadratically, so the
 * zone's inner part creeps) to `maxSpeed` at the edge, inside a `zone`
 * deep band along each edge. Past the bottom edge is full speed; above the
 * top edge is the all-day lane, which never scrolls. The zone shrinks to a
 * third of a short viewport so the middle third always stands still.
 */
export const edgeScrollStep = (
  state: EdgeScrollState,
  y: number,
  viewport: { readonly bottom: number; readonly top: number },
  zone: number,
  maxSpeed: number,
): EdgeScrollStep => {
  // Callable from a reanimated gesture or frame callback on the UI thread
  // (iOS); inert everywhere else.
  'worklet';
  const height = viewport.bottom - viewport.top;
  if (height <= 0 || zone <= 0 || y < viewport.top) {
    return { state, velocity: 0 };
  }
  const depth = Math.min(zone, height / 3);
  const topInner = viewport.top + depth;
  const bottomInner = viewport.bottom - depth;
  const armedTop = state.armedTop || (y >= topInner && y <= viewport.bottom);
  const armedBottom = state.armedBottom || y <= bottomInner;
  const next =
    armedTop === state.armedTop && armedBottom === state.armedBottom
      ? state
      : { armedBottom, armedTop };
  if (y < topInner && armedTop) {
    const reach = (topInner - y) / depth;
    return { state: next, velocity: -maxSpeed * reach * reach };
  }
  if (y > bottomInner && armedBottom) {
    const reach = Math.min((y - bottomInner) / depth, 1);
    return { state: next, velocity: maxSpeed * reach * reach };
  }
  return { state: next, velocity: 0 };
};
