import type { BridgeTransport } from '@calendar/core';
import { GeoClient, geoClientFrom } from '@calendar/geo';
import { Layer } from 'effect';
import { loadGeoModule } from '../modules/solunivo-geo/index.ts';

/**
 * GeoClient over the local Expo module (apps/ios/modules/solunivo-geo).
 * A dev client built before the module existed degrades to "no
 * suggestions, no map" instead of crashing at import.
 */
const native = loadGeoModule();

const transport: BridgeTransport | { readonly unavailable: string } = native
  ? { invoke: (method, params) => native.invoke(method, params), subscribe: () => () => {} }
  : { unavailable: 'geo module not in this build — rebuild the dev client' };

export const iosGeoLayer: Layer.Layer<GeoClient> = Layer.succeed(
  GeoClient,
  geoClientFrom(transport),
);
