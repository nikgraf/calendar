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
import { namedPastLead, placeMatch, sameAddress, saysOnlyKind, saysWhere } from './resemblance.ts';

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

  it('reads the whole text, lead and all: a name may begin with one', () => {
    // Real venues: the name is the whole text.
    for (const name of [
      'Am Hof',
      'Zum Schwarzen Kameel',
      'Beim Czaak',
      'Chez Panisse',
      'In der Burg',
      'At Home',
      'Auf der Schmelz',
      'Zur Eisernen Zeit',
    ]) {
      expect(placeMatch(name, { name }), name).toBe('exact');
      expect(placeMatch(name.toLowerCase(), { name }), name).toBe('exact');
    }
    expect(placeMatch('in vino', { name: 'In Vino Veritas' })).toBe('words');
    // No place is called "im Figlmüller": the whole text names none.
    const figlmueller = { address: 'Bäckerstraße 6, 1010 Vienna, Austria', name: 'Figlmüller' };
    expect(placeMatch('im Figlmüller', figlmueller)).toBeUndefined();
    expect(placeMatch('Am Hof', { address: 'Hof, Bavaria, Germany', name: 'Hof' })).toBeUndefined();
  });

  it('knows a venue called what the text says past its lead', () => {
    // The bench: a model asked for the place copies the words that led
    // into it.
    const figlmueller = { address: 'Bäckerstraße 6, 1010 Vienna, Austria', name: 'Figlmüller' };
    for (const text of ['im Figlmüller', 'beim Figlmüller', 'at Figlmüller', 'in dem Figlmüller']) {
      expect(namedPastLead(text, figlmueller), text).toBe(true);
    }
    expect(namedPastLead('at the Loos Bar', { name: 'Loos Bar' })).toBe(true);
    expect(namedPastLead('in der Praxis Dr. Huber', { name: 'Praxis Dr. Huber' })).toBe(true);
    // An article that is the name's stays with it.
    expect(namedPastLead('at the Standard', { name: 'The Standard' })).toBe(true);
    // No lead, nothing after it, or a name that begins with it (read whole).
    expect(namedPastLead('Figlmüller', figlmueller)).toBe(false);
    expect(namedPastLead('im', figlmueller)).toBe(false);
    expect(namedPastLead('in der', figlmueller)).toBe(false);
    expect(namedPastLead('Am Hof', { name: 'Am Hof' })).toBe(false);
    expect(namedPastLead('Café im Figlmüller', figlmueller)).toBe(false);
  });

  it('reads past a lead only into the whole name of a venue', () => {
    // Review (Opus): each of these took a hit that main only offered.
    expect(namedPastLead('beim Zahnarzt', { name: 'Zahnarzt Dr. Müller' })).toBe(false);
    expect(namedPastLead('at the dentist', { name: 'Dentist Dr. Smith' })).toBe(false);
    expect(namedPastLead('zum Arzt', { name: 'Arzt Dr. Huber' })).toBe(false);
    expect(namedPastLead('beim Friseur', { name: 'Friseur Klier' })).toBe(false);
    expect(namedPastLead('bei Anna', { name: 'Café Anna' })).toBe(false);
    expect(
      namedPastLead('im Figlmüller', {
        address: 'Bäckerstraße 6, 1010 Vienna, Austria',
        name: 'Figlmüller Bäckerstrasse',
      }),
    ).toBe(false);
    // A town or a street named in its own address is no venue.
    expect(namedPastLead('am See', { address: 'See, Tyrol, Austria', name: 'See' })).toBe(false);
    expect(namedPastLead('am Berg', { address: 'Berg, Bavaria, Germany', name: 'Berg' })).toBe(
      false,
    );
    expect(namedPastLead('im Wald', { address: '8636 Wald, Switzerland', name: 'Wald' })).toBe(
      false,
    );
    expect(namedPastLead('An der Wien', { address: 'Wien, Österreich', name: 'Wien' })).toBe(false);
    expect(namedPastLead('Am Hof', { address: 'Hof, Bavaria, Germany', name: 'Hof' })).toBe(false);
    expect(
      namedPastLead('am Graben', { address: 'Graben, 1010 Vienna, Austria', name: 'Graben' }),
    ).toBe(false);
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
    // Review: an address without its street says only where, however short.
    const noStreet = { address: '1070 Vienna, Austria', name: 'Kaffemik' };
    const cityOnly = { address: 'Vienna, Austria', name: 'Kaffemik' };
    const templeNoStreet = { address: '1190 Vienna, Austria', name: 'Vienna Austria Temple' };
    // Seen on the real search: a business called the city's words, ranked exact.
    const business = { address: 'Pfalzgasse 84, 1220 Vienna, Austria', name: 'Vienna Austria' };
    for (const place of [
      yard,
      imperial,
      center,
      temple,
      noStreet,
      cityOnly,
      templeNoStreet,
      business,
    ]) {
      expect(placeMatch('Vienna, Austria', place)).toBeUndefined();
      expect(placeMatch('Vienna', place)).toBeUndefined();
    }
    expect(
      placeMatch('Cupertino, CA', {
        address: 'Cupertino, CA, United States',
        name: '1 Infinite Loop',
      }),
    ).toBeUndefined();
    // Review: a state's ZIP or a UK postcode after the city made the city a street.
    for (const [text, place] of [
      [
        'Mountain View',
        { address: 'Mountain View, CA 94043, USA', name: '1600 Amphitheatre Pkwy' },
      ],
      ['Cupertino', { address: 'Cupertino, CA 95014', name: '1 Infinite Loop' }],
      [
        'San Francisco',
        { address: 'San Francisco, CA 94117, United States', name: 'Golden Gate Park' },
      ],
      ['London', { address: 'London, NW1 6XE, United Kingdom', name: '221B Baker Street' }],
      ['London', { address: '221B Baker Street, London, NW1 6XE, United Kingdom', name: 'Museum' }],
    ] as const) {
      expect(placeMatch(text, place)).toBeUndefined();
    }
    expect(placeMatch('Vienna Temple', temple)).toBe('words');
    // The city itself: its address begins with its name.
    const vienna = { address: 'Vienna, Austria', name: 'Vienna' };
    expect(placeMatch('Vienna, Austria', vienna)).toBe('words');
    expect(placeMatch('Vienna', vienna)).toBe('exact');
    expect(
      placeMatch('New York, NY', { address: 'New York, NY, United States', name: 'New York' }),
    ).toBe('words');
    // Review: a city whose first part holds its province's code too.
    expect(placeMatch('Toronto', { address: 'Toronto ON, Canada', name: 'Toronto' })).toBe('exact');
    // Review: a city whose address repeats its name, or begins with its postal code.
    const city = { address: 'Vienna, Vienna, Austria', name: 'Vienna' };
    expect(placeMatch('Vienna', city)).toBe('exact');
    expect(placeMatch('Vienna, Austria', city)).toBe('words');
    expect(placeMatch('Hallstatt', { address: '4830 Hallstatt, Austria', name: 'Hallstatt' })).toBe(
      'exact',
    );
    expect(placeMatch('Sydney', { address: 'Sydney NSW, Australia', name: 'Sydney' })).toBe(
      'exact',
    );
    // A word of the place's own beside the city still names it.
    expect(placeMatch('Imperial Vienna', imperial)).toBe('words');
    expect(placeMatch('Austria Center', center)).toBe('words');
    expect(placeMatch('Mistplatz', yard)).toBe('words');
    expect(placeMatch('Richthausenstraße 2, Vienna', yard)).toBe('words');
    expect(placeMatch('Kaffemik Vienna', noStreet)).toBe('words');
    // A postal code and a city are where it is, not which place.
    expect(placeMatch('1170 Vienna', yard)).toBeUndefined();
  });

  it('reads the street of a short address as the place’s own', () => {
    // Review: an address typed as the location ("Stephansplatz 3, 1010 Wien") lost its street.
    const cathedral = { address: 'Stephansplatz 3, 1010 Wien', name: "St. Stephen's Cathedral" };
    expect(placeMatch('Cathedral Stephansplatz 3', cathedral)).toBe('words');
    expect(placeMatch('Stephansplatz 3', cathedral)).toBe('words');
    // A street before a postal code is the place's own; the city is not.
    expect(placeMatch('Stephansplatz', cathedral)).toBe('words');
    expect(placeMatch('Wien', cathedral)).toBeUndefined();
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
    // A state's code is too short to say where, and half a city is none.
    const gary = { address: '12 Main St, Gary, IN, United States', name: 'Cafe Mick' };
    expect(saysWhere('Cafe Mick in town', gary)).toBe(false);
    expect(saysWhere('Cafe Mick Gar', gary)).toBe(false);
    expect(saysWhere('Cafe Mick, Gary', gary)).toBe(true);
    // Review: one word of a city's name is a word of many names.
    const royalOak = { address: '1 Main St, Royal Oak, MI, United States', name: 'Royal Cafe' };
    const newYork = { address: '5 Mott St, New York, NY, United States', name: 'New Moon Cafe' };
    expect(saysWhere('Royal Cafe', royalOak)).toBe(false);
    expect(saysWhere('New Moon Cafe', newYork)).toBe(false);
    // Review: a province's code is no word to say.
    const montreal = {
      address: '1227A Rue Atateken, Montréal QC H2L 3K9, Canada',
      name: 'Cafe Meekha',
    };
    expect(saysWhere('Cafe Meekha Montreal', montreal)).toBe(true);
    // Review: a city said on its own is where it is.
    expect(saysWhere('Berlin', { address: 'Berlin, Germany', name: 'Berlin' })).toBe(true);
    expect(saysWhere('Toronto', { address: 'Toronto ON, Canada', name: 'Toronto' })).toBe(true);
    const portland = { address: 'Portland, OR, United States', name: 'Portland' };
    expect(saysWhere('Portland, OR', portland)).toBe(true);
    // A street named in its own address is where it is, like a city (a nearby one still ranks first).
    const street = { address: 'Kaffeeweg, 1140 Vienna, Austria', name: 'Kaffeeweg' };
    expect(saysWhere('Kaffeeweg', street)).toBe(true);
    // Review: a region's code beside the city ("NSW") is no word to say.
    const opera = { address: 'Bennelong Point, Sydney NSW 2000, Australia', name: 'Opera Bar' };
    expect(saysWhere('Opera Bar Sydney', opera)).toBe(true);
    expect(saysWhere('Opera Bar', opera)).toBe(false);
    // Review: a name that holds its city says nothing beside the name.
    const grill = {
      address: '100 W Randolph St, Chicago, IL 60601, United States',
      name: 'Chicago Grill',
    };
    expect(saysWhere('Chicago Grill', grill)).toBe(false);
    expect(saysWhere('Chicago Grill, Chicago', grill)).toBe(true);
    expect(saysWhere('Hallstatt', { address: '4830 Hallstatt, Austria', name: 'Hallstatt' })).toBe(
      true,
    );
  });

  it('knows a text that says only a kind of place', () => {
    for (const text of [
      'home',
      'Office',
      'the office',
      'my office',
      'at the office',
      'im Büro',
      'in der Küche',
      'Hotel',
      'the hotel',
      'Kino',
      'ein Café',
      // Read as the short form an address writes ("Ctr").
      'the centre',
      'Zahnarztpraxis',
      // A store is called this too; the words are "at home", and it is offered.
      'At Home',
    ]) {
      expect(saysOnlyKind(text), text).toBe(true);
    }
    for (const text of [
      // A name beside the kind, or instead of it.
      'Hotel Sacher',
      'Loos Bar',
      'Café Prückel',
      'big meeting room',
      'room 4',
      'Vienna office',
      "Anna's house",
      'Figlmüller',
      // A compound is as often a name: the search may know the one meant.
      'Konzerthaus',
      'Schweizerhaus',
      'Hauptbahnhof',
      // A town has one, and the search knows it.
      'airport',
      'the airport',
      'Flughafen',
      'am Bahnhof',
      'Uni',
      'the stadium',
      '',
      'the',
      'im',
    ]) {
      expect(saysOnlyKind(text), text).toBe(false);
    }
  });

  it('reads two spellings of one address as the same, and two towns apart', () => {
    expect(
      sameAddress('Philharmonikerstraße 4, 1010 Wien', 'Philharmoniker Str. 4, 1010 Wien'),
    ).toBe(true);
    // The city in another language after it does not count.
    expect(
      sameAddress('Zollergasse 5, 1070 Vienna, Austria', 'Zollergasse 5, 1070 Wien, Österreich'),
    ).toBe(true);
    expect(sameAddress('Wollzeile 5, 1010 Wien', 'Wollzeile 6, 1010 Wien')).toBe(false);
    // Review: numbers run together made two buildings one.
    expect(sameAddress('1-2-34 Shibuya, Tokyo', '1-23-4 Shibuya, Tokyo')).toBe(false);
    expect(sameAddress(undefined, '')).toBe(true);
    // Review: one street and number in two cities is two places.
    expect(sameAddress('1 Main St, Boston', '1 Main St, New York')).toBe(false);
    expect(sameAddress('1 Main St, Boston, MA 02108', '1 Main St, Boston')).toBe(true);
    expect(
      sameAddress('Hauptplatz 1, 2340 Mödling, Austria', 'Hauptplatz 1, 2500 Baden, Austria'),
    ).toBe(false);
    expect(sameAddress('Zollergasse 5, Vienna', 'Zollergasse 5, 1070 Vienna, Austria')).toBe(true);
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

  it('knows what is nearby: a day trip from any recent place, a part of the world from a zone', () => {
    const graz = { lat: 47.0707, lng: 15.4395 };
    const london = { lat: 51.5074, lng: -0.1278 };
    const benoni = { lat: -26.1885, lng: 28.3208 };
    const lisbon = { lat: 38.7223, lng: -9.1393 };
    const events = densestRegion([vienna])!;
    expect(events.near.meters).toBe(HISTORY_NEAR_METERS);
    expect(isNearby(events, graz)).toBe(true);
    expect(isNearby(events, berlin)).toBe(false);
    // Review: a trip's events outnumbered home's and made home far.
    const trip = densestRegion([lisbon, lisbon, vienna])!;
    expect(trip.lat).toBeCloseTo(lisbon.lat, 3);
    expect(isNearby(trip, graz)).toBe(true);
    expect(isNearby(trip, berlin)).toBe(false);
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
      near: { meters: TIME_ZONE_NEAR_METERS, points: [vienna] },
      radiusMeters: TIME_ZONE_REGION_RADIUS_METERS,
    });
    expect(regionForTimeZone('Etc/UTC')).toBeUndefined();
  });
});
