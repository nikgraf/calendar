import { describe, expect, it } from 'vitest';
import { EventRecord, GeoLocation } from '../types.ts';
import {
  decodeGeoProperties,
  encodeGeoProperties,
  GEO_PROPERTY_KEYS,
  geoMatches,
  isMappableLocation,
  normalizeLocationKey,
  openInMapsUrl,
  placeSuggestionLabel,
  withConsistentGeo,
} from './location.ts';

const geo = new GeoLocation({
  lat: 37.7823,
  lng: -122.4076,
  name: 'Blue Bottle Coffee',
  source: 'Blue Bottle Coffee, 66 Mint St, San Francisco',
});

const record = (fields: Partial<EventRecord> = {}): EventRecord =>
  new EventRecord({
    accountId: 'a',
    calendarId: 'c',
    endUtc: 2,
    etag: null,
    id: 'e',
    isAllDay: false,
    startUtc: 1,
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: 'Coffee',
    updatedAt: 0,
    ...fields,
  });

describe('normalizeLocationKey', () => {
  it('ignores case and whitespace differences', () => {
    expect(normalizeLocationKey('  Blue  Bottle\nCoffee ')).toBe('blue bottle coffee');
  });
});

describe('isMappableLocation', () => {
  it('accepts place text', () => {
    expect(isMappableLocation('66 Mint St, San Francisco')).toBe(true);
  });

  it('rejects empty text, URLs and meeting links', () => {
    expect(isMappableLocation(undefined)).toBe(false);
    expect(isMappableLocation('   ')).toBe(false);
    expect(isMappableLocation('https://example.com/room')).toBe(false);
    expect(isMappableLocation('Zoom: https://us02web.zoom.us/j/8881234567')).toBe(false);
    expect(isMappableLocation('meet.google.com/abc-defg-hij')).toBe(true);
  });
});

describe('geoMatches', () => {
  it('matches the normalized source text', () => {
    expect(geoMatches(geo, 'blue bottle coffee,  66 Mint St, San Francisco')).toBe(true);
    expect(geoMatches(geo, 'Somewhere else')).toBe(false);
    expect(geoMatches(undefined, geo.source)).toBe(false);
  });
});

describe('withConsistentGeo', () => {
  it('keeps matching coordinates', () => {
    const event = record({ geo, location: geo.source });
    expect(withConsistentGeo(event)).toBe(event);
  });

  it('drops coordinates once the location text changed or was cleared', () => {
    expect(withConsistentGeo(record({ geo, location: 'Office' })).geo).toBeUndefined();
    expect(withConsistentGeo(record({ geo })).geo).toBeUndefined();
  });
});

describe('extended property codec', () => {
  it('round-trips through the private properties', () => {
    const encoded = encodeGeoProperties(geo, { forPatch: false });
    expect(encoded).toEqual({
      [GEO_PROPERTY_KEYS.coordinates]: '37.7823,-122.4076',
      [GEO_PROPERTY_KEYS.name]: 'Blue Bottle Coffee',
      [GEO_PROPERTY_KEYS.source]: geo.source,
    });
    expect(decodeGeoProperties(encoded as Record<string, string>, geo.source)).toEqual(geo);
  });

  it('clears every key on a patch without geo, and sends nothing on insert', () => {
    expect(encodeGeoProperties(undefined, { forPatch: true })).toEqual({
      [GEO_PROPERTY_KEYS.coordinates]: null,
      [GEO_PROPERTY_KEYS.name]: null,
      [GEO_PROPERTY_KEYS.source]: null,
    });
    expect(encodeGeoProperties(undefined, { forPatch: false })).toEqual({});
  });

  it('clears the name key on a patch when the place has no name', () => {
    const unnamed = new GeoLocation({ lat: 1, lng: 2, source: 'Somewhere' });
    expect(encodeGeoProperties(unnamed, { forPatch: true })[GEO_PROPERTY_KEYS.name]).toBeNull();
  });

  it('refuses a source Google would truncate', () => {
    const long = new GeoLocation({ lat: 1, lng: 2, source: 'x'.repeat(1025) });
    expect(encodeGeoProperties(long, { forPatch: false })).toEqual({});
  });

  it('ignores coordinates derived from different location text', () => {
    const encoded = encodeGeoProperties(geo, { forPatch: false }) as Record<string, string>;
    expect(decodeGeoProperties(encoded, 'New office')).toBeUndefined();
  });

  it('ignores malformed or out-of-range coordinates', () => {
    const source = { [GEO_PROPERTY_KEYS.source]: 'Here' };
    for (const coordinates of ['', 'abc', '1', '1,2,3', '91,0', '0,181', ',5']) {
      expect(
        decodeGeoProperties({ ...source, [GEO_PROPERTY_KEYS.coordinates]: coordinates }, 'Here'),
      ).toBeUndefined();
    }
    expect(decodeGeoProperties(undefined, 'Here')).toBeUndefined();
  });
});

describe('links and labels', () => {
  it('builds an https Apple Maps link', () => {
    expect(openInMapsUrl(geo)).toBe(
      'https://maps.apple.com/?ll=37.7823,-122.4076&q=Blue%20Bottle%20Coffee',
    );
  });

  it('joins title and subtitle', () => {
    expect(placeSuggestionLabel({ subtitle: '66 Mint St', title: 'Blue Bottle' })).toBe(
      'Blue Bottle, 66 Mint St',
    );
    expect(placeSuggestionLabel({ title: 'Paris' })).toBe('Paris');
  });
});
