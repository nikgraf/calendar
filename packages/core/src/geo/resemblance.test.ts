import { describe, expect, it } from 'vite-plus/test';
import { koelnerKey } from './phonetic.ts';
import {
  densestRegion,
  distanceMeters,
  HISTORY_REGION_RADIUS_METERS,
  regionForTimeZone,
  TIME_ZONE_REGION_RADIUS_METERS,
} from './regions.ts';
import { placeMatch, placesResembling } from './resemblance.ts';

describe('koelnerKey', () => {
  it('gives words that sound alike the same key', () => {
    // The pairs MapKit's search did not recover (probe, 2026-10-18).
    expect(koelnerKey('Cafe Zentral')).toBe(koelnerKey('Café Central'));
    expect(koelnerKey('Kaffee Sperl')).toBe(koelnerKey('Café Sperl'));
    expect(koelnerKey('Blachutta')).toBe(koelnerKey('Plachutta'));
    expect(koelnerKey('Fickelmüller')).toBe(koelnerKey('Figlmüller'));
    expect(koelnerKey('Nashmarkt')).toBe(koelnerKey('Naschmarkt'));
    expect(koelnerKey('Stefansdom')).toBe(koelnerKey('Stephansdom'));
    expect(koelnerKey('Müller')).toBe(koelnerKey('Mueller'.replace('ue', 'u')));
  });

  it('keeps different names apart and leaves numbers out', () => {
    expect(koelnerKey('Figlmüller')).not.toBe(koelnerKey('Plachutta'));
    expect(koelnerKey('Café Central')).not.toBe(koelnerKey('Café Sperl'));
    expect(koelnerKey('Wollzeile 5')).toBe(koelnerKey('Wollzeile'));
    expect(koelnerKey('5')).toBe('');
    expect(koelnerKey('Meier')).toBe('67');
  });
});

describe('placeMatch', () => {
  it('reads the same name as exact, a beginning as words, the same sound as phonetic', () => {
    expect(placeMatch('café central', { name: 'Café Central' })).toBe('exact');
    expect(placeMatch('Figlmüller', { name: 'Figlmüller Bäckerstrasse' })).toBe('words');
    expect(
      placeMatch('Figlmüller Wollzeile', {
        address: 'Wollzeile 5, 1010 Vienna',
        name: 'Figlmüller',
      }),
    ).toBe('words');
    expect(
      placeMatch('Wollzeile 5', { address: 'Wollzeile 5, 1010 Vienna', name: 'Wollzeile 5' }),
    ).toBe('exact');
    expect(placeMatch('Cafe Zentral', { name: 'Café Central' })).toBe('phonetic');
    expect(placeMatch('Blachutta', { name: 'Plachutta Wollzeile' })).toBe('phonetic');
  });

  it('rejects what a search found for a text that names no such place', () => {
    // Observed: "Room 4" → a street in Weidling, "Cafe Zentral" → an ice cream shop.
    expect(
      placeMatch('Room 4', { address: 'Am Rahm 4, 3400 Weidling', name: 'Am Rahm 4' }),
    ).toBeUndefined();
    expect(placeMatch('Cafe Zentral', { name: 'Zanoni & Zanoni' })).toBeUndefined();
    expect(placeMatch('Kaffee Sperl', { name: 'Kaffeeweg' })).toBeUndefined();
    expect(placeMatch('Blachutta', { name: 'Blachutova' })).toBeUndefined();
    expect(placeMatch('  ', { name: 'Anything' })).toBeUndefined();
    expect(placeMatch('Café', { address: '', name: '' })).toBeUndefined();
  });

  it('ranks the places that resemble a text, best first, the rest in their order', () => {
    const central = { name: 'Café Central' };
    const centralBranch = { name: 'Café Central Nord' };
    const zentral = { name: 'Zentral Garage' };
    const zanoni = { name: 'Zanoni & Zanoni' };
    expect(placesResembling('Cafe Zentral', [zanoni, zentral, centralBranch, central])).toEqual([
      centralBranch,
      central,
    ]);
    expect(placesResembling('Café Central', [zanoni, centralBranch, central])).toEqual([
      central,
      centralBranch,
    ]);
  });
});

describe('regions', () => {
  const vienna = { lat: 48.2082, lng: 16.3738 };
  const berlin = { lat: 52.52, lng: 13.405 };

  it('measures distance on the sphere', () => {
    expect(Math.round(distanceMeters(vienna, berlin) / 1000)).toBe(524);
    expect(distanceMeters(vienna, vienna)).toBe(0);
  });

  it('centers on the densest cluster, the first point winning a tie', () => {
    const near = { lat: 48.21, lng: 16.4 };
    const region = densestRegion([berlin, vienna, near]);
    expect(region?.radiusMeters).toBe(HISTORY_REGION_RADIUS_METERS);
    expect(region?.lat).toBeCloseTo((vienna.lat + near.lat) / 2, 5);
    expect(region?.lng).toBeCloseTo((vienna.lng + near.lng) / 2, 5);
    // One point each: the first (the most recent, by the caller's order).
    expect(densestRegion([berlin, vienna])).toMatchObject(berlin);
    expect(densestRegion([])).toBeUndefined();
  });

  it('knows a time zone’s city, or not', () => {
    expect(regionForTimeZone('Europe/Vienna')).toEqual({
      ...vienna,
      radiusMeters: TIME_ZONE_REGION_RADIUS_METERS,
    });
    expect(regionForTimeZone('Etc/UTC')).toBeUndefined();
  });
});
