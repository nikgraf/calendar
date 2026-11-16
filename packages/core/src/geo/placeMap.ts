import { distanceMeters, type GeoPoint, HISTORY_NEAR_METERS } from './regions.ts';

/**
 * Where a few places go on one small map — the Assistant's "which place?"
 * and its card: which stretch of the world the map shows, where each
 * place's pin stands on it, and which places are too far off to be on it
 * at all. Both apps draw the pins themselves over a plain map image of
 * exactly that stretch (`rect`), so a pin is where this says, the same on
 * the iPhone and the Mac.
 *
 * One map cannot show two places a street apart and a third in another
 * city: zoomed out to the city they are one spot, zoomed in the city is
 * off the map. So the map fits the places within a day trip of each other
 * (the largest such group, the best-ranked first among equals); pins the
 * fit still puts on top of each other stand side by side on short legs
 * from their spot; and a place farther off is a tag on the map's edge,
 * pointing its way, with how far it is.
 */

/** A stretch of the Web Mercator world, in fractions of it (MapKit's `MKMapRect` over `MKMapSize.world`). */
export interface MapRect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

/** A place's pin, in points from the map's top left. */
export interface PlaceMapPin {
  /** The place's index among those given. */
  readonly index: number;
  /** Where the place itself is, when its pin stands on a leg from there. */
  readonly spot?: { readonly x: number; readonly y: number } | undefined;
  readonly x: number;
  readonly y: number;
}

/** A place off the map: a tag on the side it lies beyond. */
export interface PlaceMapEdge {
  /** Along the side: the tag's middle, in points from the top (left, right) or the left (top, bottom). */
  readonly at: number;
  readonly index: number;
  /** From the map's center. */
  readonly meters: number;
  readonly side: 'bottom' | 'left' | 'right' | 'top';
}

export interface PlaceMap {
  readonly edges: ReadonlyArray<PlaceMapEdge>;
  readonly pins: ReadonlyArray<PlaceMapPin>;
  /** The stretch the map image shows, its aspect the map's own. */
  readonly rect: MapRect;
}

/** Places this far apart are on one map: a day trip, as far as a place search calls "nearby". */
export const PLACE_MAP_GROUP_METERS = HISTORY_NEAR_METERS;
/**
 * At least this much of the world shows along the map's shorter side:
 * a street and its corners around one place (the editor's map), a
 * street's length for several, so two doors 60 m apart are two pins.
 */
export const PLACE_MAP_MIN_METERS = 700;
export const PLACE_MAP_MIN_GROUP_METERS = 250;
/** Room kept between a pin and the map's edge: a pin's radius and some. */
const PAD = 22;
/** More at the bottom, where Apple's Maps logo and Legal link sit on the image. */
const PAD_BOTTOM = 34;
/** Pins nearer than this would hide each other (a 24-point pin and a little air). */
const COLLIDE = 32;
/** How far pins on legs stand from their spot, and from each other: a tap target's width. */
const LEG_RISE = 34;
const LEG_SPACING = 44;
/**
 * An edge tag keeps clear of the corners by this much along its side —
 * of the expand button at the top right and Apple's logo at the bottom
 * left, a tag being up to 100 points wide and 30 high.
 */
const EDGE_CLEAR_SIDE = 22;
const EDGE_CLEAR_ENDS = 96;
const EDGE_CLEAR_LOGO = 116;
/** Two edge tags on one side keep this far apart: a tag's height on a side, its width on the top or bottom. */
const EDGE_STACK = 34;
const EDGE_STACK_WIDE = 104;

const EARTH_CIRCUMFERENCE_METERS = 40_075_016.686;

/** A point's place in the Web Mercator world: x and y in [0, 1], y growing south. */
export const toMercator = (point: GeoPoint): { readonly x: number; readonly y: number } => {
  const lat = Math.max(Math.min(point.lat, 85.05112878), -85.05112878);
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: (point.lng + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI),
  };
};

/** The point at a place in the Web Mercator world. */
const fromMercator = ({ x, y }: { readonly x: number; readonly y: number }): GeoPoint => ({
  lat: (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI,
  lng: x * 360 - 180,
});

/** Points to a hundredth: a pin a hair off is the same pin, and tests can say where it is. */
const round = (value: number): number => Math.round(value * 100) / 100;

/** A longitude moved by whole turns to lie within half a turn of `near`: no group spans the world for crossing 180°. */
const unwrap = (lng: number, near: number): number => lng - 360 * Math.round((lng - near) / 360);

/**
 * The places that go on the map: the largest group within a day trip of
 * one of them, that one the first given among equals — the candidates
 * come best first.
 */
const group = (places: ReadonlyArray<GeoPoint>): ReadonlyArray<number> => {
  let best: ReadonlyArray<number> = [];
  for (const seed of places) {
    const members = places.flatMap((place, index) =>
      distanceMeters(seed, place) <= PLACE_MAP_GROUP_METERS ? [index] : [],
    );
    if (members.length > best.length) {
      best = members;
    }
  }
  return best;
};

/** The group on the map, every place in the world's terms, and the group's bounds there. */
interface Fit {
  readonly maxX: number;
  readonly maxY: number;
  readonly members: ReadonlyArray<number>;
  readonly middle: { readonly x: number; readonly y: number };
  readonly minX: number;
  readonly minY: number;
  readonly world: ReadonlyArray<{ readonly x: number; readonly y: number }>;
}

const fit = (places: ReadonlyArray<GeoPoint>): Fit | undefined => {
  const members = group(places);
  const [seed] = members;
  if (seed === undefined) {
    return undefined;
  }
  const seedLng = places[seed]?.lng ?? 0;
  const world = places.map((place) => toMercator({ ...place, lng: unwrap(place.lng, seedLng) }));
  const fitted = members.flatMap((index) => world[index] ?? []);
  const minX = Math.min(...fitted.map((point) => point.x));
  const maxX = Math.max(...fitted.map((point) => point.x));
  const minY = Math.min(...fitted.map((point) => point.y));
  const maxY = Math.max(...fitted.map((point) => point.y));
  return {
    maxX,
    maxY,
    members,
    middle: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    minX,
    minY,
    world,
  };
};

/** Pins too near each other, gathered (each a set of positions in `points`). */
const collisions = (
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>,
): ReadonlyArray<ReadonlyArray<number>> => {
  const root = points.map((_, index) => index);
  const find = (index: number): number => {
    let at = index;
    while (root[at] !== at) {
      at = root[at] ?? at;
    }
    return at;
  };
  points.forEach((a, i) => {
    points.forEach((b, j) => {
      if (j > i && Math.hypot(a.x - b.x, a.y - b.y) < COLLIDE) {
        root[find(j)] = find(i);
      }
    });
  });
  const sets = new Map<number, Array<number>>();
  points.forEach((_, index) => {
    const key = find(index);
    sets.set(key, [...(sets.get(key) ?? []), index]);
  });
  return [...sets.values()];
};

/**
 * Pins that would hide each other, side by side in a row above the middle
 * of their spots — below it where the map's top is too near, moved in
 * from the sides — each on a leg from its own place.
 */
const onLegs = (
  members: ReadonlyArray<{ readonly index: number; readonly x: number; readonly y: number }>,
  width: number,
  height: number,
): ReadonlyArray<PlaceMapPin> => {
  const middle = {
    x: members.reduce((sum, pin) => sum + pin.x, 0) / members.length,
    y: members.reduce((sum, pin) => sum + pin.y, 0) / members.length,
  };
  const up = middle.y - LEG_RISE >= PAD || middle.y + LEG_RISE > height - PAD_BOTTOM;
  const y = up ? middle.y - LEG_RISE : middle.y + LEG_RISE;
  const row = (members.length - 1) * LEG_SPACING;
  const left = Math.min(Math.max(middle.x - row / 2, PAD), Math.max(width - PAD - row, PAD));
  return [...members]
    .sort((a, b) => a.index - b.index)
    .map((pin, at) => ({
      index: pin.index,
      spot: { x: pin.x, y: pin.y },
      x: round(left + at * LEG_SPACING),
      y: round(y),
    }));
};

/**
 * The pins as they stand: each crowd on legs; a crowd whose row lands a
 * pin on another pin takes that one's crowd in, until none does — each
 * merge leaves one crowd fewer, so it ends.
 */
const settle = (
  placed: ReadonlyArray<{ readonly index: number; readonly x: number; readonly y: number }>,
  width: number,
  height: number,
): ReadonlyArray<PlaceMapPin> => {
  let crowds = collisions(placed).map((set) => set.flatMap((position) => placed[position] ?? []));
  for (;;) {
    const stands = crowds.map((crowd) =>
      crowd.length > 1
        ? onLegs(crowd, width, height)
        : crowd.map(({ index, x, y }) => ({ index, x, y })),
    );
    const owner = (stand: number, at: number) =>
      stands.findIndex(
        (other, which) => which !== stand && other.some((pin) => near(pin, stands[stand]?.[at])),
      );
    const clash = stands.flatMap((stand, which) =>
      stand.flatMap((_, at) => {
        const other = owner(which, at);
        return other === -1 ? [] : [[which, other] as const];
      }),
    )[0];
    if (clash === undefined) {
      return stands.flat().sort((a, b) => a.index - b.index);
    }
    const [a, b] = clash;
    crowds = [
      ...crowds.filter((_, which) => which !== a && which !== b),
      [...(crowds[a] ?? []), ...(crowds[b] ?? [])],
    ];
  }
};

/** Two pins nearer than they can both be seen and tapped. */
const near = (
  a: { readonly x: number; readonly y: number },
  b: { readonly x: number; readonly y: number } | undefined,
): boolean => b !== undefined && Math.hypot(a.x - b.x, a.y - b.y) < COLLIDE;

/**
 * Where along a side a tag may stand: off the corners, where it would
 * cover the expand button or Apple's logo, and above the logo's strip.
 */
const sideRange = (
  side: PlaceMapEdge['side'],
  width: number,
  height: number,
): { readonly from: number; readonly to: number } => {
  if (side === 'left' || side === 'right') {
    return { from: EDGE_CLEAR_SIDE, to: Math.max(height - PAD_BOTTOM - 8, EDGE_CLEAR_SIDE) };
  }
  const from = side === 'bottom' ? EDGE_CLEAR_LOGO : EDGE_CLEAR_ENDS;
  return { from, to: Math.max(width - EDGE_CLEAR_ENDS, from) };
};

/** Where a ray from the map's middle toward a point leaves the map: the side, and how far along it. */
const edgeOf = (
  dx: number,
  dy: number,
  width: number,
  height: number,
): { readonly at: number; readonly side: PlaceMapEdge['side'] } => {
  const halfW = width / 2;
  const halfH = height / 2;
  // How far the ray goes, in its own lengths, before each pair of sides.
  const toSides = dx === 0 ? Infinity : halfW / Math.abs(dx);
  const toEnds = dy === 0 ? Infinity : halfH / Math.abs(dy);
  const side: PlaceMapEdge['side'] =
    toSides <= toEnds ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'top' : 'bottom';
  const at = toSides <= toEnds ? halfH + dy * toSides : halfW + dx * toEnds;
  const { from, to } = sideRange(side, width, height);
  return { at: round(Math.min(Math.max(at, from), to)), side };
};

/**
 * Tags on one side, moved apart along it in the order they lie and kept
 * within its range: pushed on from the first, then back from the end.
 * More than a side holds overlap at its start.
 */
const stacked = (
  edges: ReadonlyArray<PlaceMapEdge>,
  width: number,
  height: number,
): ReadonlyArray<PlaceMapEdge> => {
  const out: Array<PlaceMapEdge> = [];
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    const gap = side === 'left' || side === 'right' ? EDGE_STACK : EDGE_STACK_WIDE;
    const { from, to } = sideRange(side, width, height);
    const row = edges.filter((each) => each.side === side).sort((a, b) => a.at - b.at);
    const ats = row.map((edge) => edge.at);
    ats.forEach((at, i) => {
      ats[i] = i === 0 ? at : Math.max(at, (ats[i - 1] ?? at) + gap);
    });
    for (let i = ats.length - 1; i >= 0; i -= 1) {
      const next = ats[i + 1];
      ats[i] = Math.max(Math.min(ats[i] ?? 0, next === undefined ? to : next - gap), from);
    }
    row.forEach((edge, i) => out.push({ ...edge, at: round(ats[i] ?? edge.at) }));
  }
  return out.sort((a, b) => a.index - b.index);
};

/**
 * How far each place lies from the map's middle when it is off the map
 * (a tag on its edge), undefined for one on it — what a row adds to its
 * address. The same for any size of map.
 */
export const offMapMeters = (
  places: ReadonlyArray<GeoPoint>,
): ReadonlyArray<number | undefined> => {
  const fitted = fit(places);
  return places.map((place, index) =>
    fitted === undefined || fitted.members.includes(index)
      ? undefined
      : distanceMeters(fromMercator(fitted.middle), place),
  );
};

/**
 * The map for `places` (best first) at `width` × `height` points; none
 * for no places or no room, or a stretch MapKit cannot draw (across 180°). A single place sits in the middle, a little
 * above it for the room the logo takes.
 */
export const placeMapLayout = (
  places: ReadonlyArray<GeoPoint>,
  { height, width }: { readonly height: number; readonly width: number },
): PlaceMap | undefined => {
  const fitted = fit(places);
  if (fitted === undefined || width <= PAD * 2 || height <= PAD + PAD_BOTTOM) {
    return undefined;
  }
  const { maxX, maxY, members, middle, minX, minY, world } = fitted;
  // Points per world unit: the group fits inside the padding, and the
  // shorter side shows at least a street's worth.
  const latitude = fromMercator(middle).lat;
  const minMeters = members.length > 1 ? PLACE_MAP_MIN_GROUP_METERS : PLACE_MAP_MIN_METERS;
  const minWorld = minMeters / (EARTH_CIRCUMFERENCE_METERS * Math.cos((latitude * Math.PI) / 180));
  const scale = Math.min(
    maxX > minX ? (width - PAD * 2) / (maxX - minX) : Infinity,
    maxY > minY ? (height - PAD - PAD_BOTTOM) / (maxY - minY) : Infinity,
    Math.min(width, height) / minWorld,
  );
  // The group's middle at the middle of the room the padding leaves.
  const rect = {
    height: height / scale,
    width: width / scale,
    x: middle.x - width / scale / 2,
    y: middle.y - (PAD + (height - PAD - PAD_BOTTOM) / 2) / scale,
  };
  // MapKit renders no image of a street-sized stretch across 180° (it
  // fails after a minute), nor one past the world's top or bottom.
  if (rect.x < 0 || rect.x + rect.width > 1 || rect.y < 0 || rect.y + rect.height > 1) {
    return undefined;
  }
  const at = (point: { readonly x: number; readonly y: number }) => ({
    x: round((point.x - rect.x) * scale),
    y: round((point.y - rect.y) * scale),
  });
  const placed = members.map((index) => ({ index, ...at(world[index] ?? middle) }));
  const pins = settle(placed, width, height);
  const meters = offMapMeters(places);
  const edges = places.flatMap((_, index) => {
    const point = world[index];
    const off = meters[index];
    if (off === undefined || point === undefined) {
      return [];
    }
    const { x, y } = at(point);
    const { at: along, side } = edgeOf(x - width / 2, y - height / 2, width, height);
    return [{ at: along, index, meters: off, side }];
  });
  return { edges: stacked(edges, width, height), pins, rect };
};

/**
 * A distance as a tag or a row says it: "250 km", "8,000 km" — whole
 * kilometers, since a place off the map is a day trip away or more.
 */
export const formatDistance = (meters: number): string =>
  `${String(Math.round(meters / 1000)).replaceAll(/\B(?=(\d{3})+(?!\d))/g, ',')} km`;

/**
 * A live map's camera on the places a layout fits: the middle of their
 * group and a zoom that shows all of it with some air (expo-maps reads
 * a zoom as 360 / 2^zoom degrees each way).
 */
export const placeMapCamera = (
  places: ReadonlyArray<GeoPoint>,
): { readonly center: GeoPoint; readonly zoom: number } | undefined => {
  const members = group(places).flatMap((index) => places[index] ?? []);
  const [first] = members;
  if (first === undefined) {
    return undefined;
  }
  const lngs = members.map((place) => unwrap(place.lng, first.lng));
  const lats = members.map((place) => place.lat);
  const span = Math.max(
    (Math.max(...lngs) - Math.min(...lngs)) * 1.6,
    (Math.max(...lats) - Math.min(...lats)) * 1.6,
    0.008,
  );
  return {
    center: {
      lat: (Math.max(...lats) + Math.min(...lats)) / 2,
      lng: unwrap((Math.max(...lngs) + Math.min(...lngs)) / 2, 0),
    },
    zoom: Math.log2(360 / span),
  };
};
