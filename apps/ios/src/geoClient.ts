import type { BridgeTransport } from '@calendar/core';
import { GeoClient, geoClientFrom } from '@calendar/geo';
import { Layer } from 'effect';
import { loadGeoModule } from '../modules/solunivo-geo/index.ts';

/**
 * `EXPO_PUBLIC_CALENDAR_GEO=off` (inlined at bundle time; CI's e2e bundle
 * sets it) leaves MapKit out, like the desktop's `CALENDAR_GEO=off`: no
 * suggestions, no lookups and so no map, and no flow waits on Apple's
 * servers.
 */
const geoOff = process.env['EXPO_PUBLIC_CALENDAR_GEO'] === 'off';

/**
 * GeoClient over the local Expo module (apps/ios/modules/solunivo-geo).
 * A dev client built before the module existed degrades to "no
 * suggestions, no map" instead of crashing at import.
 */
const native = geoOff ? undefined : loadGeoModule();

const transport: BridgeTransport | { readonly unavailable: string } = geoOff
  ? { unavailable: 'geo switched off (EXPO_PUBLIC_CALENDAR_GEO=off)' }
  : native
    ? { invoke: (method, params) => native.invoke(method, params), subscribe: () => () => {} }
    : { unavailable: 'geo module not in this build — rebuild the dev client' };

export const iosGeoLayer: Layer.Layer<GeoClient> = Layer.succeed(
  GeoClient,
  geoClientFrom(transport),
);
