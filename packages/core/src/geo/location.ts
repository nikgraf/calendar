import { Schema } from 'effect';
import { meetingUrl } from '../meeting.ts';
import { EventRecord, GeoLocation } from '../types.ts';

/**
 * Event locations are free text in Google Calendar — the API has no
 * place id and no coordinates. The app derives coordinates on-device and
 * treats the text as the source of truth: a GeoLocation is only valid
 * while its `source` still matches the event's location.
 */

/** A typeahead row as MapKit's completer returns it. */
export const PlaceSuggestion = Schema.Struct({
  subtitle: Schema.optional(Schema.String),
  title: Schema.String,
});
export type PlaceSuggestion = typeof PlaceSuggestion.Type;

/** The text a picked suggestion writes into the location field. */
export const placeSuggestionLabel = (suggestion: PlaceSuggestion): string =>
  suggestion.subtitle ? `${suggestion.title}, ${suggestion.subtitle}` : suggestion.title;

/**
 * Comparison form of a location string: the cache key and the staleness
 * test. Whitespace and case differences never invalidate coordinates.
 */
export const normalizeLocationKey = (location: string): string =>
  location.normalize('NFC').trim().replaceAll(/\s+/g, ' ').toLowerCase();

const URL_LIKE = /^[a-z][\w+.-]*:\/\//i;

/**
 * Whether a location string names a place worth geocoding: not empty,
 * not a URL, and not a video-call link (a Zoom URL in the location
 * field is the common case).
 */
export const isMappableLocation = (location: string | undefined): location is string => {
  const text = location?.trim() ?? '';
  return text !== '' && !URL_LIKE.test(text) && meetingUrl({ location: text }) === undefined;
};

/** True while `geo` was derived from (a normalization of) `location`. */
export const geoMatches = (
  geo: GeoLocation | undefined,
  location: string | undefined,
): geo is GeoLocation =>
  geo !== undefined &&
  isMappableLocation(location) &&
  normalizeLocationKey(geo.source) === normalizeLocationKey(location);

/**
 * The record with stale coordinates dropped. Every local write passes
 * through this, so "the location changed but the coordinates did not"
 * cannot be persisted or pushed.
 */
export const withConsistentGeo = (record: EventRecord): EventRecord =>
  record.geo === undefined || geoMatches(record.geo, record.location)
    ? record
    : new EventRecord({ ...record, geo: undefined });

/** Keys in Google's extendedProperties.private (each ≤ 44 chars). */
export const GEO_PROPERTY_KEYS = {
  coordinates: 'solunivo.geo',
  name: 'solunivo.geoName',
  source: 'solunivo.geoSource',
} as const;

/** Google silently truncates longer values, which would break the source match. */
const MAX_PROPERTY_VALUE = 1024;

const CLEARED = {
  [GEO_PROPERTY_KEYS.coordinates]: null,
  [GEO_PROPERTY_KEYS.name]: null,
  [GEO_PROPERTY_KEYS.source]: null,
} as const;

const formatCoordinate = (value: number): string => String(Number(value.toFixed(6)));

/**
 * The private extended properties carrying `geo`. For a patch, a missing
 * or unstorable geo becomes explicit nulls (Google merges private keys on
 * PATCH and deletes a key only when it is sent as null). For an insert
 * there is nothing to clear, so it is simply empty.
 */
export const encodeGeoProperties = (
  geo: GeoLocation | undefined,
  options: { readonly forPatch: boolean },
): Record<string, string | null> => {
  if (geo === undefined || geo.source.length > MAX_PROPERTY_VALUE) {
    return options.forPatch ? { ...CLEARED } : {};
  }
  const properties: Record<string, string | null> = {
    [GEO_PROPERTY_KEYS.coordinates]: `${formatCoordinate(geo.lat)},${formatCoordinate(geo.lng)}`,
    [GEO_PROPERTY_KEYS.source]: geo.source,
  };
  if (geo.name !== undefined && geo.name.length <= MAX_PROPERTY_VALUE) {
    properties[GEO_PROPERTY_KEYS.name] = geo.name;
  } else if (options.forPatch) {
    properties[GEO_PROPERTY_KEYS.name] = null;
  }
  return properties;
};

/**
 * Reads `geo` back from Google's private extended properties. Anything
 * malformed, out of range, or derived from different location text (the
 * location was edited in another client) yields undefined.
 */
export const decodeGeoProperties = (
  properties: Readonly<Record<string, string>> | undefined,
  location: string | undefined,
): GeoLocation | undefined => {
  const coordinates = properties?.[GEO_PROPERTY_KEYS.coordinates];
  const source = properties?.[GEO_PROPERTY_KEYS.source];
  if (coordinates === undefined || source === undefined) {
    return undefined;
  }
  const parts = coordinates.split(',');
  if (parts.length !== 2) {
    return undefined;
  }
  const [lat, lng] = parts.map((part) => (part.trim() === '' ? Number.NaN : Number(part)));
  if (
    lat === undefined ||
    lng === undefined ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  ) {
    return undefined;
  }
  const name = properties?.[GEO_PROPERTY_KEYS.name];
  const geo = new GeoLocation({ lat, lng, name: name || undefined, source });
  return geoMatches(geo, location) ? geo : undefined;
};

/**
 * Apple Maps link for a resolved place. https (not maps://): the desktop
 * window-open handler only hands https URLs to the OS, and macOS and iOS
 * both route maps.apple.com to the Maps app.
 */
export const openInMapsUrl = (geo: GeoLocation): string =>
  `https://maps.apple.com/?ll=${formatCoordinate(geo.lat)},${formatCoordinate(geo.lng)}&q=${encodeURIComponent(geo.name ?? geo.source)}`;
