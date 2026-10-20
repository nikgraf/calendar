import { type BridgeTransport, bridgeMessage, type PlaceSuggestion } from '@calendar/core';
import { Context, Data, Effect, Layer, Schema } from 'effect';
import {
  GEO_METHODS,
  type GeoPlaceJson,
  type ResolveParams,
  ResolveResult,
  type SearchParams,
  SearchResult,
  type SnapshotParams,
  SnapshotResult,
} from './protocol.ts';

/** No native geocoding bridge on this build/platform (helper missing, module absent, e2e off). */
export class GeoUnavailableError extends Data.TaggedError('GeoUnavailableError')<{
  readonly message: string;
}> {}

/** The bridge answered with an error (MapKit failure, bad response, …). */
export class GeoRequestError extends Data.TaggedError('GeoRequestError')<{
  readonly message: string;
  readonly method: string;
}> {}

export type GeoError = GeoRequestError | GeoUnavailableError;

export interface GeoClientShape {
  /**
   * The places free text or a picked suggestion resolve to, MapKit's
   * best first; empty when nothing matched. A picked suggestion is one
   * exact place.
   */
  readonly resolve: (params: ResolveParams) => Effect.Effect<ReadonlyArray<GeoPlaceJson>, GeoError>;
  /** Typeahead rows for partial location text. */
  readonly search: (
    params: SearchParams,
  ) => Effect.Effect<ReadonlyArray<PlaceSuggestion>, GeoError>;
  /** A map image centered on the coordinates, PNG as base64. */
  readonly snapshot: (params: SnapshotParams) => Effect.Effect<string, GeoError>;
}

export class GeoClient extends Context.Service<GeoClient, GeoClientShape>()('geo/GeoClient') {}

/** Only what is set goes on the wire: an older native side knows no region. */
const defined = (params: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));

/**
 * A transport-agnostic implementation over "send a method + JSON params,
 * get JSON back" — the desktop helper stdio call and the iOS Expo module
 * both fit that shape, so each platform only supplies `invoke`.
 */
export const makeGeoClient = (
  invoke: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
): GeoClientShape => {
  const call = <A, I>(
    method: string,
    params: Record<string, unknown>,
    result: Schema.Codec<A, I>,
  ): Effect.Effect<A, GeoError> =>
    Effect.tryPromise({
      catch: (error): GeoError => {
        const message = bridgeMessage(error instanceof Error ? error.message : String(error));
        return message.includes('helper unavailable')
          ? new GeoUnavailableError({ message })
          : new GeoRequestError({ message, method });
      },
      try: () => invoke(method, params),
    }).pipe(
      Effect.flatMap((raw) =>
        Schema.decodeUnknownEffect(result)(raw).pipe(
          Effect.mapError(
            (error) => new GeoRequestError({ message: `bad response: ${String(error)}`, method }),
          ),
        ),
      ),
    );

  return {
    resolve: (params) =>
      Effect.map(
        call(
          GEO_METHODS.resolve,
          defined({
            limit: params.limit,
            query: params.query,
            region: params.region && { ...params.region },
            suggestion: params.suggestion && { ...params.suggestion },
          }),
          ResolveResult,
        ),
        // A native side from before `places`: its one place is the list.
        (r) => (r.places ?? (r.place ? [r.place] : [])).map(oneLineAddress),
      ),
    search: (params) =>
      Effect.map(
        call(
          GEO_METHODS.search,
          defined({
            limit: params.limit,
            query: params.query,
            region: params.region && { ...params.region },
          }),
          SearchResult,
        ),
        (r) => r.results,
      ),
    snapshot: (params) =>
      Effect.map(call(GEO_METHODS.snapshot, { ...params }, SnapshotResult), (r) => r.pngBase64),
  };
};

/** Every method fails with GeoUnavailableError — builds without a bridge (tests, e2e off). */
export const unavailableGeoClient = (reason: string): GeoClientShape => {
  const fail = <A>(): Effect.Effect<A, GeoError> =>
    Effect.fail(new GeoUnavailableError({ message: reason }));
  return { resolve: () => fail(), search: () => fail(), snapshot: () => fail() };
};

/**
 * MapKit's address as one line. On iOS 26 `fullAddress` of a place
 * resolved from a completer row comes in postal lines ("Stephansplatz 11\n1010
 * Wien\nÖsterreich") where the search's places read "…, 1010 Vienna, Austria";
 * a chip or a location field is one line either way.
 */
const oneLineAddress = (place: GeoPlaceJson): GeoPlaceJson => {
  if (place.address === undefined || !/\n/.test(place.address)) {
    return place;
  }
  const address = place.address
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(', ');
  return { ...place, address };
};

/** One layer per host — see contactsLayer for the shape. No change events. */
export const geoClientFrom = (
  source: BridgeTransport | { readonly unavailable: string },
): GeoClientShape =>
  'unavailable' in source ? unavailableGeoClient(source.unavailable) : makeGeoClient(source.invoke);

export const geoLayer = (
  source: BridgeTransport | { readonly unavailable: string },
): Layer.Layer<GeoClient> => Layer.succeed(GeoClient, geoClientFrom(source));
