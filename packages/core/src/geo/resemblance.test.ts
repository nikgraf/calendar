import { describe, expect, it } from 'vite-plus/test';
import { koelnerKey } from './phonetic.ts';
import {
  CLUSTER_POINT_LIMIT,
  densestRegion,
  distanceMeters,
  HISTORY_NEAR_METERS,
  HISTORY_REGION_RADIUS_METERS,
  isNearby,
  regionForTimeZone,
  TIME_ZONE_NEAR_METERS,
  TIME_ZONE_REGION_RADIUS_METERS,
} from './regions.ts';
import { placeMatch, placesResembling, sameAddress, saysWhere } from './resemblance.ts';

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

  it('reads street words as MapKit abbreviates them', () => {
    // Review: "66 Mint Street" was no match for "66 Mint St" and cached as a miss.
    expect(
      placeMatch('66 Mint Street, San Francisco', {
        address: '66 Mint St, San Francisco, CA',
        name: '66 Mint St',
      }),
    ).toBe('words');
    expect(
      placeMatch('Hauptstraße 12', { address: 'Hauptstr. 12, 1010 Wien', name: 'Hauptstr. 12' }),
    ).toBe('exact');
    expect(placeMatch('Park Avenue', { name: 'Park Ave' })).toBe('exact');
    // Review: "Parkway" and "Highway" were missing, and a good geocode cached as a miss.
    expect(
      placeMatch('1600 Amphitheatre Parkway', {
        address: '1600 Amphitheatre Pkwy, Mountain View, CA',
        name: '1600 Amphitheatre Pkwy',
      }),
    ).toBe('exact');
    expect(placeMatch('Pacific Coast Highway', { name: 'Pacific Coast Hwy' })).toBe('exact');
    expect(placeMatch("Saint Stephen's Cathedral", { name: "St. Stephen's Cathedral" })).toBe(
      'exact',
    );
  });

  it('reads a word that is also a property of every object', () => {
    // Review: "constructor" reached Object's own and threw.
    expect(placeMatch('Constructor University', { name: 'Constructor University Bremen' })).toBe(
      'words',
    );
    expect(placeMatch('toString', { name: 'Prototype Café' })).toBeUndefined();
    expect(regionForTimeZone('constructor')).toBeUndefined();
  });

  it('takes a number only as it is', () => {
    // Review: "Wollzeile 5" sounded like Wollzeile 6 and began Wollzeile 50.
    expect(placeMatch('Wollzeile 5', { name: 'Wollzeile 6' })).toBeUndefined();
    expect(placeMatch('Wollzeile 5', { name: 'Wollzeile 50' })).toBeUndefined();
    expect(
      placeMatch('Wollzeile 5', { address: 'Wollzeile 5, 1010 Vienna', name: 'Figlmüller' }),
    ).toBe('words');
    expect(placeMatch('Wolzeile 5', { name: 'Wollzeile 5' })).toBe('phonetic');
    // Review: a letter on the number ("12a") slipped past the guard.
    expect(placeMatch('Hauptstraße 12a', { name: 'Hauptstraße 13a' })).toBeUndefined();
    expect(placeMatch('Hauptstraße 12a', { name: 'Hauptstraße 12' })).toBeUndefined();
    expect(placeMatch('Hauptstrasse 12a', { name: 'Hauptstraße 12a' })).toBe('exact');
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

  it('hears a name dictation cut into words it knows', () => {
    // Observed 2026-11-06: Kaffemik, dictated in English, three ways.
    const kaffemik = { address: 'Zollergasse 5, 1070 Vienna, Austria', name: 'Kaffemik' };
    expect(placeMatch('Cafe Meek', kaffemik)).toBe('phonetic');
    expect(placeMatch('Cafe Mick', kaffemik)).toBe('phonetic');
    expect(placeMatch('coffee Nick', kaffemik)).toBe('phonetic');
    expect(placeMatch('Kaffeemik', kaffemik)).toBe('phonetic');
    // The other way round, and with more of the name after it.
    expect(placeMatch('Figlmüller', { name: 'Figl Müller' })).toBe('phonetic');
    expect(placeMatch('Cafe Meek', { name: 'Kaffemik Rösterei' })).toBe('phonetic');
    // Not a name that only begins alike, and not on a sound too short to tell.
    expect(placeMatch('Cafe Meek', { name: 'Kaffeeweg' })).toBeUndefined();
    expect(placeMatch('Cafe Meek', { name: 'Kaffee' })).toBeUndefined();
    expect(placeMatch('A B', { name: 'Abba' })).toBeUndefined();
  });

  it('takes a city for the city, not for a place that stands in it', () => {
    // Observed 2026-11-06: "Vienna, Austria" took the latest past place in Vienna.
    const yard = {
      address: 'Richthausenstraße 2, 1170 Vienna, Austria',
      name: 'Mistplatz Hernals',
    };
    const imperial = {
      address: 'Kärntner Ring 16, 1010 Vienna, Austria',
      name: 'Hotel Imperial (Vienna, Austria)',
    };
    const center = {
      address: 'Bruno-Kreisky-Platz 1, 1220 Vienna, Austria',
      name: 'Austria Center Vienna',
    };
    // Seen on the real search: a name that begins with the city's words sounded like them.
    const temple = {
      address: 'Silbergasse 2, 1190 Vienna, Austria',
      name: 'Vienna Austria Temple',
    };
    for (const place of [yard, imperial, center, temple]) {
      expect(placeMatch('Vienna, Austria', place)).toBeUndefined();
      expect(placeMatch('Vienna', place)).toBeUndefined();
    }
    expect(placeMatch('Vienna Temple', temple)).toBe('words');
    // The city itself: its address begins with it.
    expect(placeMatch('Vienna, Austria', { address: 'Vienna, Austria', name: 'Vienna' })).toBe(
      'words',
    );
    expect(placeMatch('Vienna', { address: 'Vienna, Austria', name: 'Vienna' })).toBe('exact');
    // A word of the place's own beside the city still names it.
    expect(placeMatch('Imperial Vienna', imperial)).toBe('words');
    expect(placeMatch('Austria Center', center)).toBe('words');
    expect(placeMatch('Mistplatz', yard)).toBe('words');
    expect(placeMatch('Richthausenstraße 2, Vienna', yard)).toBe('words');
    // A postal code and a city are where it is, not which place.
    expect(placeMatch('1170 Vienna', yard)).toBeUndefined();
  });

  it('reads whether a text says where a place is', () => {
    const adlon = {
      address: 'Unter den Linden 77, 10117 Berlin, Germany',
      name: 'Hotel Adlon Kempinski Berlin',
    };
    expect(saysWhere('Hotel Adlon Berlin', adlon)).toBe(true);
    expect(saysWhere('Hotel Adlon', adlon)).toBe(false);
    // The street is which place, not where; a number says nothing.
    expect(saysWhere('Unter den Linden', adlon)).toBe(false);
    expect(saysWhere('Adlon 10117', adlon)).toBe(false);
    expect(
      saysWhere('Cafe Meek', {
        address: '9 10th Avenue, Benoni, Gauteng, 1501, South Africa',
        name: 'Meek Café',
      }),
    ).toBe(false);
    expect(saysWhere('Cafe Meek', { name: 'Meek Café' })).toBe(false);
    // "in" is not Indiana, and half a word is no city.
    const gary = { address: '12 Main St, Gary, IN, United States', name: 'Cafe Mick' };
    expect(saysWhere('Cafe Mick in town', gary)).toBe(false);
    expect(saysWhere('Cafe Mick Gar', gary)).toBe(false);
    expect(saysWhere('Cafe Mick, Gary', gary)).toBe(true);
  });

  it('reads two spellings of one address as the same', () => {
    expect(
      sameAddress('Philharmonikerstraße 4, 1010 Wien', 'Philharmoniker Str. 4, 1010 Wien'),
    ).toBe(true);
    expect(sameAddress('Wollzeile 5, 1010 Wien', 'Wollzeile 6, 1010 Wien')).toBe(false);
    expect(sameAddress(undefined, '')).toBe(true);
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

  it('reads only the first points, the most recent, so the work stays bounded', () => {
    // Review: thousands of points made every keystroke wait on an O(n²) pass.
    const far = Array.from({ length: CLUSTER_POINT_LIMIT }, (_, index) => ({
      lat: 10 + index * 0.001,
      lng: 10,
    }));
    const region = densestRegion([...far, ...Array.from({ length: 50 }, () => vienna)]);
    expect(region?.lat).toBeCloseTo(10.2, 1);
  });

  it('averages longitudes on the circle', () => {
    // Review: two points 11 km apart across the antimeridian averaged to 0°.
    const region = densestRegion([
      { lat: -16.78, lng: 179.95 },
      { lat: -16.8, lng: -179.95 },
    ]);
    expect(Math.abs(region!.lng)).toBeCloseTo(180, 3);
    expect(region!.lat).toBeCloseTo(-16.79, 5);
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

  it('knows what is nearby: a day trip from the events, a part of the world from a zone', () => {
    const graz = { lat: 47.0707, lng: 15.4395 };
    const london = { lat: 51.5074, lng: -0.1278 };
    const benoni = { lat: -26.1885, lng: 28.3208 };
    const events = densestRegion([vienna])!;
    expect(events.nearMeters).toBe(HISTORY_NEAR_METERS);
    expect(isNearby(events, graz)).toBe(true);
    expect(isNearby(events, berlin)).toBe(false);
    const zone = regionForTimeZone('Europe/Vienna')!;
    // A zone's city is not where the user is: Berlin's holds Munich too.
    expect(isNearby(zone, berlin)).toBe(true);
    expect(isNearby(zone, london)).toBe(true);
    expect(isNearby(zone, benoni)).toBe(false);
    // Nothing known of where the user is: nothing is far.
    expect(isNearby(undefined, benoni)).toBe(true);
  });

  it('knows a time zone’s city, or not', () => {
    expect(regionForTimeZone('Europe/Vienna')).toEqual({
      ...vienna,
      nearMeters: TIME_ZONE_NEAR_METERS,
      radiusMeters: TIME_ZONE_REGION_RADIUS_METERS,
    });
    expect(regionForTimeZone('Etc/UTC')).toBeUndefined();
  });
});
