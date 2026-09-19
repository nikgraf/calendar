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
  /** Coordinates for free text or a picked suggestion; null when nothing matched. */
  readonly resolve: (params: ResolveParams) => Effect.Effect<GeoPlaceJson | null, GeoError>;
  /** Typeahead rows for partial location text. */
  readonly search: (
    params: SearchParams,
  ) => Effect.Effect<ReadonlyArray<PlaceSuggestion>, GeoError>;
  /** A map image centered on the coordinates, PNG as base64. */
  readonly snapshot: (params: SnapshotParams) => Effect.Effect<string, GeoError>;
}

export class GeoClient extends Context.Service<GeoClient, GeoClientShape>()('geo/GeoClient') {}

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
          params.suggestion
            ? { query: params.query, suggestion: { ...params.suggestion } }
            : { query: params.query },
          ResolveResult,
        ),
        (r) => r.place,
      ),
    search: (params) =>
      Effect.map(
        call(
          GEO_METHODS.search,
          params.limit === undefined
            ? { query: params.query }
            : { limit: params.limit, query: params.query },
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

/** One layer per host — see contactsLayer for the shape. No change events. */
export const geoClientFrom = (
  source: BridgeTransport | { readonly unavailable: string },
): GeoClientShape =>
  'unavailable' in source ? unavailableGeoClient(source.unavailable) : makeGeoClient(source.invoke);

export const geoLayer = (
  source: BridgeTransport | { readonly unavailable: string },
): Layer.Layer<GeoClient> => Layer.succeed(GeoClient, geoClientFrom(source));
