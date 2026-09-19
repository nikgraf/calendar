import { PlaceSuggestion } from '@calendar/core';
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

export { PlaceSuggestion };

/** A resolved place: coordinates plus MapKit's name and address. */
export const GeoPlaceJson = Schema.Struct({
  address: Schema.optional(Schema.String),
  lat: Schema.Number,
  lng: Schema.Number,
  name: Schema.optional(Schema.String),
});
export type GeoPlaceJson = typeof GeoPlaceJson.Type;

export const SearchResult = Schema.Struct({ results: Schema.Array(PlaceSuggestion) });
/** `place` is null when nothing matched — a normal outcome, not an error. */
export const ResolveResult = Schema.Struct({ place: Schema.NullOr(GeoPlaceJson) });
export const SnapshotResult = Schema.Struct({ pngBase64: Schema.String });

export interface SearchParams {
  readonly limit?: number | undefined;
  readonly query: string;
}

export interface ResolveParams {
  readonly query: string;
  /** The typeahead row the user picked; resolves that exact completion. */
  readonly suggestion?: PlaceSuggestion | undefined;
}

export interface SnapshotParams {
  readonly appearance: 'dark' | 'light';
  /** Points; the image is rendered at height × scale pixels. */
  readonly height: number;
  readonly lat: number;
  readonly lng: number;
  readonly scale: number;
  readonly width: number;
}

/** Method names as the native sides dispatch them. */
export const GEO_METHODS = {
  resolve: 'geo.resolve',
  search: 'geo.search',
  snapshot: 'geo.snapshot',
} as const;
