import { describe, expect, it } from 'vite-plus/test';
import {
  formatDistance,
  offMapMeters,
  type PlaceMap,
  placeMapCamera,
  placeMapLayout,
  toMercator,
} from './placeMap.ts';
import { distanceMeters } from './regions.ts';

// The question map's size on the iPhone: the card's width, 150 tall.
const SIZE = { height: 150, width: 338 };

const WOLLZEILE = { lat: 48.20911, lng: 16.37475 };
const BAECKERSTRASSE = { lat: 48.20943, lng: 16.3768 };
const GRINZING = { lat: 48.25595, lng: 16.34143 };
const SACHER = { lat: 48.20393, lng: 16.36968 };
const SACHER_ECK = { lat: 48.20341, lng: 16.37014 };
const SALZBURG = { lat: 47.80447, lng: 13.04402 };
const PRAGUE = { lat: 50.0875, lng: 14.4213 };
const HIETZING = { lat: 48.18651, lng: 16.30017 };
const NUSSDORF = { lat: 48.25866, lng: 16.36891 };

const layout = (places: ReadonlyArray<{ lat: number; lng: number }>): PlaceMap => {
  const map = placeMapLayout(places, SIZE);
  if (map === undefined) {
    throw new Error('no map');
  }
  return map;
};

/** A pin's place, by the map's own projection: what the map image shows there. */
const projected = (map: PlaceMap, place: { lat: number; lng: number }) => {
  const point = toMercator(place);
  return {
    x: ((point.x - map.rect.x) / map.rect.width) * SIZE.width,
    y: ((point.y - map.rect.y) / map.rect.height) * SIZE.height,
  };
};

/** Pins keep off the bottom 34 points, where the image has Apple's logo. */
const inside = (pin: { x: number; y: number }) =>
  pin.x >= 12 && pin.x <= SIZE.width - 12 && pin.y >= 12 && pin.y <= SIZE.height - 22;
/** The middle of the room left: 22 at the top, 34 at the bottom. */
const MIDDLE_Y = 22 + (SIZE.height - 22 - 34) / 2;

describe('placeMapLayout', () => {
  it('puts one place in the middle of a street-sized map', () => {
    const map = layout([SACHER]);
    expect(map.pins).toEqual([{ index: 0, x: SIZE.width / 2, y: MIDDLE_Y }]);
    expect(map.edges).toEqual([]);
    // The rect has the map's own aspect, so the image is not stretched.
    expect(map.rect.width / map.rect.height).toBeCloseTo(SIZE.width / SIZE.height, 9);
    // The shorter side shows 700 m.
    const top = { ...SACHER, lat: SACHER.lat + 0.001 };
    const metersPerPoint =
      distanceMeters(SACHER, top) / Math.abs(projected(map, top).y - projected(map, SACHER).y);
    expect(metersPerPoint * SIZE.height).toBeCloseTo(700, -1);
  });

  it('fits places across a city, each pin where its place is', () => {
    const places = [WOLLZEILE, HIETZING, NUSSDORF];
    const map = layout(places);
    expect(map.edges).toEqual([]);
    expect(map.pins.map((pin) => pin.index)).toEqual([0, 1, 2]);
    for (const pin of map.pins) {
      expect(pin.spot).toBeUndefined();
      expect(inside(pin)).toBe(true);
      const where = projected(map, places[pin.index] ?? WOLLZEILE);
      expect(pin.x).toBeCloseTo(where.x, 1);
      expect(pin.y).toBeCloseTo(where.y, 1);
    }
  });

  it('stands two places a street apart on legs, with the third across town', () => {
    const map = layout([WOLLZEILE, BAECKERSTRASSE, GRINZING]);
    expect(map.edges).toEqual([]);
    const [one, two, three] = map.pins;
    expect(one?.spot).toBeDefined();
    expect(two?.spot).toEqual(one?.spot);
    // Side by side, a tap target apart, above their spot, in their order.
    expect(one?.y).toBe(two?.y);
    expect((two?.x ?? 0) - (one?.x ?? 0)).toBe(44);
    expect(one?.y).toBeLessThan(one?.spot?.y ?? 0);
    // The spot is where the two are, between them.
    const a = projected(map, WOLLZEILE);
    const b = projected(map, BAECKERSTRASSE);
    expect(one?.spot?.x).toBeCloseTo((a.x + b.x) / 2, 1);
    expect(three?.spot).toBeUndefined();
    expect(map.pins.every(inside)).toBe(true);
  });

  it('keeps two doors 60 m apart as two pins at street level', () => {
    const map = layout([SACHER, SACHER_ECK]);
    expect(map.pins.map((pin) => pin.spot)).toEqual([undefined, undefined]);
    const [one, two] = map.pins;
    expect(
      Math.hypot((one?.x ?? 0) - (two?.x ?? 0), (one?.y ?? 0) - (two?.y ?? 0)),
    ).toBeGreaterThan(32);
  });

  it('puts a place in another city on the edge it lies beyond, with its distance', () => {
    const map = layout([SACHER, SACHER_ECK, SALZBURG]);
    expect(map.pins.map((pin) => pin.index)).toEqual([0, 1]);
    expect(map.edges).toHaveLength(1);
    const [salzburg] = map.edges;
    expect(salzburg?.index).toBe(2);
    expect(salzburg?.side).toBe('left');
    expect(salzburg?.meters).toBeGreaterThan(245_000);
    expect(salzburg?.meters).toBeLessThan(255_000);
    // A little below the middle: Salzburg lies west and a bit south.
    expect(salzburg?.at).toBeGreaterThan(SIZE.height / 2);
  });

  it('fits the larger group, whichever came first', () => {
    const map = layout([SALZBURG, SACHER, SACHER_ECK]);
    expect(map.pins.map((pin) => pin.index)).toEqual([1, 2]);
    expect(map.edges.map((edge) => edge.index)).toEqual([0]);
  });

  it('fits the first place given when no two are near each other', () => {
    const map = layout([SALZBURG, SACHER]);
    expect(map.pins).toEqual([{ index: 0, x: SIZE.width / 2, y: MIDDLE_Y }]);
    expect(map.edges.map((edge) => [edge.index, edge.side])).toEqual([[1, 'right']]);
  });

  it('moves tags on one side apart', () => {
    const map = layout([SACHER, SACHER_ECK, PRAGUE, { lat: 50.1, lng: 14.5 }]);
    const sides = map.edges.map((edge) => edge.side);
    expect(sides).toEqual(['top', 'top']);
    const [a, b] = map.edges;
    expect(Math.abs((a?.at ?? 0) - (b?.at ?? 0))).toBeGreaterThan(33.99);
  });

  it('keeps places either side of 180° together', () => {
    const map = layout([
      { lat: -16.78, lng: 179.99 },
      { lat: -16.79, lng: -179.99 },
    ]);
    expect(map.edges).toEqual([]);
    expect(map.pins.every(inside)).toBe(true);
    expect(map.rect.width).toBeLessThan(0.001);
  });

  it('has no map for no places or no room', () => {
    expect(placeMapLayout([], SIZE)).toBeUndefined();
    expect(placeMapLayout([SACHER], { height: 30, width: 338 })).toBeUndefined();
  });
});

describe('offMapMeters', () => {
  it('says how far the places off the map are, as their tags do', () => {
    const places = [SACHER, SACHER_ECK, SALZBURG];
    const meters = offMapMeters(places);
    expect(meters.slice(0, 2)).toEqual([undefined, undefined]);
    expect(meters[2]).toBe(layout(places).edges[0]?.meters);
    expect(offMapMeters([])).toEqual([]);
  });
});

describe('formatDistance', () => {
  it('says whole kilometers, thousands grouped', () => {
    expect(formatDistance(250_400)).toBe('250 km');
    expect(formatDistance(8_012_000)).toBe('8,012 km');
    expect(formatDistance(149_600)).toBe('150 km');
  });
});

describe('placeMapCamera', () => {
  it('centers on the group a layout fits, leaving the far one out', () => {
    const camera = placeMapCamera([SACHER, SACHER_ECK, SALZBURG]);
    expect(camera?.center.lat).toBeCloseTo((SACHER.lat + SACHER_ECK.lat) / 2, 6);
    expect(camera?.center.lng).toBeCloseTo((SACHER.lng + SACHER_ECK.lng) / 2, 6);
    // A street's worth: 360 / 2^zoom degrees, at least 0.008°.
    expect(360 / 2 ** (camera?.zoom ?? 0)).toBeCloseTo(0.008, 6);
  });

  it('zooms out to show a city', () => {
    const camera = placeMapCamera([WOLLZEILE, HIETZING, NUSSDORF]);
    const span = 360 / 2 ** (camera?.zoom ?? 0);
    expect(span).toBeCloseTo((WOLLZEILE.lng - HIETZING.lng) * 1.6, 6);
  });
});
