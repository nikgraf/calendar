import { readFileSync } from 'node:fs';
import { GeoClient, geoClientFrom, type GeoClientShape, makeFakeGeoClient } from '@calendar/geo';
import { Layer } from 'effect';
import { helperTransport } from './helperProcess.ts';

/**
 * CALENDAR_GEO=fixture: the e2e harness hands the app a JSON list of
 * places and the in-memory fake serves search, resolve and a constant map
 * image — deterministic and offline, no MapKit or network involved.
 */
const fixtureClient = (): GeoClientShape | undefined => {
  const path = process.env['CALENDAR_GEO_FIXTURE'];
  if (process.env['CALENDAR_GEO'] !== 'fixture' || !path) {
    return undefined;
  }
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as Parameters<typeof makeFakeGeoClient>[0];
  return makeFakeGeoClient(fixture).client;
};

/**
 * GeoClient over the Swift helper: every `geo.*` method is one stdio
 * request answered by MapKit. CALENDAR_GEO=off (the e2e default) makes it
 * unavailable, which the backend degrades to "no suggestions, no map".
 */
export const desktopGeoLayer: Layer.Layer<GeoClient> = Layer.succeed(
  GeoClient,
  fixtureClient() ?? geoClientFrom(helperTransport('CALENDAR_GEO')),
);
