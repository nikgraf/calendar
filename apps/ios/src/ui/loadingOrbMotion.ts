/**
 * The loading orb's motion as pure worklets; `LoadingOrb.tsx` draws it.
 *
 * The orb is three rings of dots crossing like orbits, seen a little from
 * above. The dots run along their rings (the middle one against the
 * others) while the rings turn about the vertical and rock a little, so
 * the dots weave through each other; a dot's depth sets its size and
 * brightness. The rings differ in lean, spacing and dot count: even ones
 * line up into a grid now and then. Beside the orb, a bright band sweeps
 * across the label.
 *
 * Everything runs off one phase, 0 to 1 through a loop of `LOOP_MS`. Each
 * motion turns a whole number of times per loop, so phase 1 draws what
 * phase 0 does and the loop has no seam.
 *
 * Reduce Motion (`still`): the dots stay where they are and the orb and
 * the label breathe instead, a fade being what replaces movement.
 */

/** One loop of every motion, in milliseconds. */
export const LOOP_MS = 6000;

const TAU = Math.PI * 2;
const degrees = (angle: number) => (angle / 360) * TAU;

/** Each ring's dots. */
const RING_DOTS = [11, 10, 9] as const;
/** How far each ring leans out of the horizontal. */
const RING_LEANS = [degrees(56), degrees(68), degrees(80)] as const;
/** Where each ring stands about the vertical, in turns. */
const RING_OFFSETS = [0, 0.36, 0.71] as const;
/** Turns each ring's dots make along it per loop. */
const RING_TURNS = [1, -1, 1] as const;
/** How far the rings rock about their lean, once per loop. */
const ROCK = degrees(8);
/** The orb seen this far from above. */
const VIEW_TILT = degrees(16);
/** Turns the rings make about the vertical per loop. */
const SPIN_TURNS = 1;
/** Every dot of the orb, by ring and its place on it. */
export const ORB_DOTS: ReadonlyArray<{ readonly index: number; readonly ring: number }> =
  RING_DOTS.flatMap((dots, ring) => Array.from({ length: dots }, (_, index) => ({ index, ring })));

/** Where Reduce Motion holds the dots: a phase where none of them overlap. */
const STILL_PHASE = 0.07;

/** Sweeps of the label's band, and breaths under Reduce Motion, per loop. */
export const SWEEPS = 3;
/** The band's half width, as a share of the label. */
const BAND = 0.3;
/** A letter's opacity away from the band. */
const DIM = 0.4;

export interface OrbDot {
  /** Toward the viewer, -1 (farthest) to 1 (nearest). */
  readonly depth: number;
  /** Right of the centre, -1 to 1 of the orb's radius. */
  readonly x: number;
  /** Below the centre, -1 to 1 of the orb's radius. */
  readonly y: number;
}

/** Where dot `index` of ring `ring` is at `phase`. */
export const orbDot = (ring: number, index: number, phase: number, still: boolean): OrbDot => {
  'worklet';
  const at = still ? STILL_PHASE : phase;
  const along = TAU * (index / (RING_DOTS[ring] ?? 1) + (RING_TURNS[ring] ?? 1) * at);
  // On a flat ring, in the horizontal plane.
  const flatX = Math.cos(along);
  const flatZ = Math.sin(along);
  // Leaned about the x axis, rocking a little.
  const lean = (RING_LEANS[ring] ?? 0) + ROCK * Math.sin(TAU * (at + ring / RING_DOTS.length));
  const leanY = -flatZ * Math.sin(lean);
  const leanZ = flatZ * Math.cos(lean);
  // Turned about the vertical: to the ring's place, plus the spin.
  const turn = TAU * ((RING_OFFSETS[ring] ?? 0) + SPIN_TURNS * at);
  const x = flatX * Math.cos(turn) + leanZ * Math.sin(turn);
  const turnZ = -flatX * Math.sin(turn) + leanZ * Math.cos(turn);
  // Seen from a little above.
  const y = leanY * Math.cos(VIEW_TILT) - turnZ * Math.sin(VIEW_TILT);
  const depth = leanY * Math.sin(VIEW_TILT) + turnZ * Math.cos(VIEW_TILT);
  return { depth, x, y: -y };
};

/** How a dot at `depth` looks: nearer is larger and brighter. */
export const dotLook = (depth: number): { opacity: number; scale: number } => {
  'worklet';
  const near = (Math.max(-1, Math.min(1, depth)) + 1) / 2;
  return { opacity: 0.18 + 0.82 * near * near, scale: 0.5 + 0.5 * near };
};

/** 0 to 1 and back, `SWEEPS` times a loop, easing at both ends. */
export const breath = (phase: number): number => {
  'worklet';
  return 0.5 - 0.5 * Math.cos(TAU * SWEEPS * phase);
};

/**
 * The orb's opacity on top of each dot's own: whole while it moves, a
 * breath between 0.55 and 1 under Reduce Motion.
 */
export const orbOpacity = (phase: number, still: boolean): number => {
  'worklet';
  return still ? 0.55 + 0.45 * breath(phase) : 1;
};

/**
 * The opacity of the label's letter centred at `at` (0 at its start, 1 at
 * its end): lifted to 1 under the band, which enters before the first
 * letter and leaves after the last, so no letter jumps at the seam. Under
 * Reduce Motion every letter breathes together instead.
 */
export const letterOpacity = (at: number, phase: number, still: boolean): number => {
  'worklet';
  if (still) {
    return DIM + (1 - DIM) * breath(phase);
  }
  const sweep = (phase * SWEEPS) % 1;
  const centre = -BAND + sweep * (1 + 2 * BAND);
  const near = Math.max(0, 1 - Math.abs(at - centre) / BAND);
  return DIM + (1 - DIM) * near * near * (3 - 2 * near);
};
