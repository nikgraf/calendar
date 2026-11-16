import { type GeoRegion, type MapRect, PlaceSuggestion } from '@calendar/core';
import { Schema } from 'effect';

/**
 * The geocoding JSON contract shared by three implementations: this TS
 * client, the macOS Swift helper (`geo.*` stdio methods), and the iOS
 * Expo module. Both native sides compile one Swift source
 * (packages/geo/swift/GeoBridge.swift) over MapKit; the schemas here
 * decode what comes back so a drift on either side fails loudly.
 *
 * On-device and key-free: MKLocalSearchCompleter for the typeahead,
 * MKLocalSearch / CLGeocoder to resolve, MKMapSnapshotter for the
 * desktop map image. None of it prompts for location access.
 */

export { type GeoRegion, PlaceSuggestion };

/** A resolved place: coordinates plus MapKit's name and address. */
export const GeoPlaceJson = Schema.Struct({
  address: Schema.optional(Schema.String),
  lat: Schema.Number,
  lng: Schema.Number,
  name: Schema.optional(Schema.String),
});
export type GeoPlaceJson = typeof GeoPlaceJson.Type;

export const SearchResult = Schema.Struct({ results: Schema.Array(PlaceSuggestion) });
/**
 * `place` is the first match, null when nothing matched (a normal
 * outcome, not an error); `places` every match MapKit returned, best
 * first — absent from a native side built before it existed.
 */
export const ResolveResult = Schema.Struct({
  place: Schema.NullOr(GeoPlaceJson),
  places: Schema.optional(Schema.Array(GeoPlaceJson)),
});
/**
 * `fitted`: the image is the `rect` asked for, with no pin of its own —
 * absent from a native side built before rects, which drew its fixed map.
 */
export const SnapshotResult = Schema.Struct({
  fitted: Schema.optional(Schema.Boolean),
  pngBase64: Schema.String,
});
export type SnapshotResult = typeof SnapshotResult.Type;

export interface SearchParams {
  readonly limit?: number | undefined;
  readonly query: string;
  /** Where to look first — a hint to MapKit, never a filter. */
  readonly region?: GeoRegion | undefined;
}

export interface ResolveParams {
  /** Matches returned at most (free text only; a picked suggestion is one place). */
  readonly limit?: number | undefined;
  readonly query: string;
  /** Where to look first — a hint to MapKit, never a filter. */
  readonly region?: GeoRegion | undefined;
  /** The typeahead row the user picked; resolves that exact completion. */
  readonly suggestion?: PlaceSuggestion | undefined;
}

export interface SnapshotParams {
  readonly appearance: 'dark' | 'light';
  /** Points; the image is rendered at height × scale pixels. */
  readonly height: number;
  /** The center of the fixed ~700 m map with its pin, when there is no `rect`. */
  readonly lat: number;
  readonly lng: number;
  /** Exactly this stretch of the world (`placeMapLayout`), and no pin. */
  readonly rect?: MapRect | undefined;
  readonly scale: number;
  readonly width: number;
}

/** Method names as the native sides dispatch them. */
export const GEO_METHODS = {
  resolve: 'geo.resolve',
  search: 'geo.search',
  snapshot: 'geo.snapshot',
} as const;
