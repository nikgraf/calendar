import { describe, expect, it } from 'vite-plus/test';
import { GeoLocation } from '../types.ts';
import {
  mergePlaceCandidates,
  pastPlaceMatch,
  type PlaceCandidate,
  placeCandidateLabel,
  preselectedPlace,
  rankFoundPlaces,
  rankPastPlaces,
  withFoundSuggestions,
} from './candidates.ts';
import { densestRegion, regionForTimeZone } from './regions.ts';

const past = (
  source: string,
  lastUsedUtc: number,
  name?: string,
  at = { lat: 48.2, lng: 16.37 },
) => ({
  geo: new GeoLocation({ ...at, name, source }),
  lastUsedUtc,
});

const figlmueller = past('Figlmüller', 10, 'Figlmüller Wollzeile');
const lugeck = past('Figlmüller Lugeck', 20, 'Lugeck Figlmüller', { lat: 48.21, lng: 16.375 });
const central = past('Café Central', 5, 'Café Central', { lat: 48.21, lng: 16.365 });
const sperl = past('Café Sperl', 8, 'Café Sperl', { lat: 48.2, lng: 16.36 });

describe('rankPastPlaces', () => {
  it('finds past places by their text, their name, or how they sound, best first', () => {
    const ranked = rankPastPlaces('figlmüller', [lugeck, figlmueller, central]);
    expect(ranked.map((candidate) => [candidate.geo.source, candidate.match])).toEqual([
      ['Figlmüller', 'exact'],
      ['Figlmüller Lugeck', 'words'],
    ]);
    // Dictated: the past place is found by sound.
    expect(rankPastPlaces('Cafe Zentral', [sperl, central]).map((c) => c.geo.source)).toEqual([
      'Café Central',
    ]);
    // By MapKit's name for it, beside the text it was written as.
    expect(rankPastPlaces('Lugeck', [figlmueller, lugeck]).map((c) => c.geo.source)).toEqual([
      'Figlmüller Lugeck',
    ]);
    expect(rankPastPlaces('Room 4', [figlmueller, central])).toEqual([]);
    // Said by its kind alone, the user's own place of that name is the one meant.
    const office = past('Office', 30, undefined, { lat: 48.19, lng: 16.35 });
    expect(rankPastPlaces('office', [central, office]).map((c) => c.geo.source)).toEqual([
      'Office',
    ]);
    // Written with the lead a model copied: the same past place.
    expect(rankPastPlaces('im Figlmüller', [central, figlmueller]).map((c) => c.match)).toEqual([
      'words',
    ]);
  });

  it('lists one place written two ways once, under its better-ranked text', () => {
    // Review: both texts for the same spot became two chips. The same spot
    // is MapKit's name within 100 m — not the spot alone, which merged two
    // branches around the corner from each other.
    // Both are exact for "Figlmüller" (one by text, one by MapKit's name): the later use stays.
    const typed = past('Figlmüller', 10, 'Figlmüller', { lat: 48.2, lng: 16.37 });
    const wollzeile = past('Figlmüller Wollzeile', 5, 'Figlmüller', { lat: 48.2, lng: 16.3701 });
    expect(rankPastPlaces('Figlmüller', [wollzeile, typed]).map((c) => c.geo.source)).toEqual([
      'Figlmüller',
    ]);
    const lugeckBranch = past('Figlmüller', 8, 'Figlmüller Lugeck', { lat: 48.2, lng: 16.3701 });
    expect(
      rankPastPlaces('Figlmüller', [wollzeile, lugeckBranch]).map((c) => c.geo.source),
    ).toEqual(['Figlmüller', 'Figlmüller Wollzeile']);
  });

  it('keeps one entry per place text, the latest, and the most recent first among equals', () => {
    const older = past('Café Central', 1, 'Café Central', { lat: 48.2, lng: 16.3 });
    const ranked = rankPastPlaces('Café', [sperl, older, central]);
    expect(ranked.map((candidate) => [candidate.geo.source, candidate.geo.lng])).toEqual([
      ['Café Sperl', 16.36],
      ['Café Central', 16.365],
    ]);
  });
});

/** A past place as the text it was written as, with MapKit's name for it. */
const written = (source: string, name?: string) =>
  new GeoLocation({ lat: 48.2, lng: 16.35, name, source });

describe('pastPlaceMatch', () => {
  // A picked place is written "name, address".
  const yard = new GeoLocation({
    lat: 48.23,
    lng: 16.31,
    name: 'Mistplatz Hernals',
    source: 'Mistplatz Hernals, Richthausenstraße 2, 1170 Vienna, Austria',
  });
  const kaffemik = new GeoLocation({
    lat: 48.2003,
    lng: 16.3497,
    name: 'Kaffemik',
    source: 'Kaffemik, Zollergasse 5, 1070 Vienna, Austria',
  });

  it('takes a city for no past place that merely stands in it', () => {
    // Observed 2026-11-06: "Vienna, Austria" took the latest past place there.
    expect(pastPlaceMatch('Vienna, Austria', yard)).toBeUndefined();
    expect(pastPlaceMatch('Vienna', yard)).toBeUndefined();
    expect(pastPlaceMatch('Austria', kaffemik)).toBeUndefined();
    // A place written as the city itself is that text.
    const city = new GeoLocation({
      lat: 48.2,
      lng: 16.37,
      name: 'Vienna',
      source: 'Vienna, Austria',
    });
    expect(pastPlaceMatch('vienna,  austria', city)).toBe('exact');
    expect(pastPlaceMatch('Vienna', city)).toBe('exact');
  });

  it('takes a city for no past place written with a short address either', () => {
    // Review: two parts after the name read the first as the place's own street.
    for (const place of [
      written('Kaffemik, 1070 Vienna, Austria', 'Kaffemik'),
      written('Kaffemik, Vienna, Austria', 'Kaffemik'),
      // An address row picked from the typeahead: the street is its name.
      written('Zollergasse 5, 1070 Vienna, Austria', 'Zollergasse 5'),
      written('Kaffemik, Wien'),
    ]) {
      expect(pastPlaceMatch('Vienna, Austria', place)).toBeUndefined();
      expect(pastPlaceMatch('Vienna', place)).toBeUndefined();
      expect(pastPlaceMatch('Wien', place)).toBeUndefined();
    }
    // Review: US and UK past places, a ZIP or a postcode after the city.
    const amphitheatre = written(
      '1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA',
      'Googleplex',
    );
    expect(pastPlaceMatch('Mountain View', amphitheatre)).toBeUndefined();
    expect(pastPlaceMatch('Mountain View, CA', amphitheatre)).toBeUndefined();
    const park = written(
      'Golden Gate Park, San Francisco, CA 94117, United States',
      'Golden Gate Park',
    );
    expect(pastPlaceMatch('San Francisco', park)).toBeUndefined();
    expect(pastPlaceMatch('Golden Gate Park', park)).toBe('exact');
    const museum = written(
      '221B Baker Street, London, NW1 6XE, United Kingdom',
      '221B Baker Street',
    );
    expect(pastPlaceMatch('London', museum)).toBeUndefined();
    const loop = written('1 Infinite Loop, Cupertino, CA, United States', '1 Infinite Loop');
    expect(pastPlaceMatch('Cupertino, CA', loop)).toBeUndefined();
    expect(pastPlaceMatch('Infinite Loop', loop)).toBe('words');
  });

  it('reads a typed address beside MapKit’s name for it', () => {
    // Review: the text was cut at its comma, and the street left MapKit's name.
    const cathedral = new GeoLocation({
      lat: 48.2084,
      lng: 16.3735,
      name: "St. Stephen's Cathedral",
      source: 'Stephansplatz 3, 1010 Wien',
    });
    expect(pastPlaceMatch('Cathedral Stephansplatz 3', cathedral)).toBe('words');
    // As written: the text's own first part.
    expect(pastPlaceMatch('Stephansplatz 3', cathedral)).toBe('exact');
    expect(pastPlaceMatch("St. Stephen's Cathedral", cathedral)).toBe('exact');
    expect(pastPlaceMatch('Wien', cathedral)).toBeUndefined();
  });

  it('reads the whole text as written whatever its accents and spaces', () => {
    // Review: an exact text with a comma came back as words.
    const central = new GeoLocation({
      lat: 48.2105,
      lng: 16.3655,
      name: 'Café Central',
      source: 'Café Central, Herrengasse 14',
    });
    expect(pastPlaceMatch('Cafe Central, Herrengasse 14', central)).toBe('exact');
    expect(pastPlaceMatch('Café Central,Herrengasse 14', central)).toBe('exact');
  });

  it('still finds a past place by its name, its street, its whole text or its sound', () => {
    expect(pastPlaceMatch('Mistplatz Hernals', yard)).toBe('exact');
    expect(pastPlaceMatch('Mistplatz', yard)).toBe('words');
    expect(pastPlaceMatch('Richthausenstraße 2', yard)).toBe('words');
    expect(pastPlaceMatch(yard.source, yard)).toBe('exact');
    // Dictated in English: the past place is found by how it sounds.
    expect(pastPlaceMatch('Cafe Meek', kaffemik)).toBe('phonetic');
    expect(pastPlaceMatch('coffee Nick', kaffemik)).toBe('phonetic');
    // A text without a name of its own, written by hand: all of it is its name.
    const office = new GeoLocation({ lat: 48.2, lng: 16.37, source: 'Büro Wien' });
    expect(pastPlaceMatch('Büro', office)).toBe('words');
  });
});

/** A search hit in the middle of Vienna. */
const hit = (name: string, address: string) => ({ address, lat: 48.2, lng: 16.37, name });

describe('rankFoundPlaces', () => {
  const vienna = { lat: 48.2082, lng: 16.3738 };
  const events = densestRegion([vienna]);
  const benoni = {
    address: '9 10th Avenue, Benoni, Gauteng, 1501, South Africa',
    lat: -26.1885,
    lng: 28.3208,
    name: 'Meek Café',
  };
  const montreal = {
    address: '1227A Rue Atateken, Montréal QC H2L 3K9, Canada',
    lat: 45.5189,
    lng: -73.5595,
    name: 'Cafe Meekha',
  };
  const london = {
    address: '77 Heath Street, London, NW3 6UG, England',
    lat: 51.5586,
    lng: -0.1787,
    name: 'Meekhun Thai bistro',
  };
  const kaffemik = {
    address: 'Zollergasse 5, 1070 Vienna, Austria',
    lat: 48.2003,
    lng: 16.3497,
    name: 'Kaffemik',
  };
  const weg = {
    address: 'Kaffeeweg, 1140 Vienna, Austria',
    lat: 48.21,
    lng: 16.26,
    name: 'Kaffeeweg',
  };
  const read = (
    text: string,
    places: ReadonlyArray<typeof benoni>,
    region: ReturnType<typeof densestRegion>,
  ) => rankFoundPlaces(text, places, region).map(({ match, place }) => [place.name, match]);

  it('takes no namesake far from the user’s places', () => {
    // Observed 2026-11-06: "Cafe Meek", said in Vienna, took a café in South Africa.
    // One far namesake stays on offer, the search's first; the rest is noise.
    expect(read('Cafe Meek', [benoni, montreal, london], events)).toEqual([
      ['Meek Café', 'search'],
    ]);
    expect(read('Cafe Meek', [london, montreal, benoni], events)).toEqual([
      ['Cafe Meekha', 'search'],
    ]);
  });

  it('puts the nearby place the text names first, then nearby hits, then far namesakes', () => {
    expect(read('Cafe Meek', [benoni, weg, london, kaffemik], events)).toEqual([
      ['Kaffemik', 'phonetic'],
      ['Kaffeeweg', 'search'],
      ['Meek Café', 'search'],
    ]);
  });

  it('takes the nearby venue a text names past the lead it was written with', () => {
    const figlmueller = hit('Figlmüller', 'Bäckerstraße 6, 1010 Vienna, Austria');
    expect(read('im Figlmüller', [weg, figlmueller], events)).toEqual([
      ['Figlmüller', 'words'],
      ['Kaffeeweg', 'search'],
    ]);
    // Only nearby: the text says nothing of where a far one is.
    const farGrill = {
      address: '100 W Randolph St, Chicago, IL 60601, United States',
      lat: 41.8843,
      lng: -87.6324,
      name: 'Chicago Grill',
    };
    expect(read('at Chicago Grill', [farGrill], events)).toEqual([['Chicago Grill', 'search']]);
    // After every hit the whole text names: "An der Wien" is the theatre.
    const city = { address: 'Wien, Österreich', lat: 48.2082, lng: 16.3738, name: 'Wien' };
    const theatre = hit('Theater an der Wien', 'Linke Wienzeile 6, 1060 Vienna, Austria');
    expect(read('An der Wien', [city, theatre], events)).toEqual([
      ['Theater an der Wien', 'words'],
      ['Wien', 'search'],
    ]);
    const bar = hit('Wien', 'Kettenbrückengasse 1, 1050 Vienna, Austria');
    expect(read('An der Wien', [bar, theatre], events)).toEqual([
      ['Theater an der Wien', 'words'],
      ['Wien', 'words'],
    ]);
  });

  it('takes no hit past a lead that main only offered', () => {
    // Review (Opus): a trade or a person after the lead, and a far town
    // called what follows it.
    expect(
      read('beim Zahnarzt', [hit('Zahnarzt Dr. Müller', 'Neubaugasse 1, 1070 Vienna')], events),
    ).toEqual([['Zahnarzt Dr. Müller', 'search']]);
    expect(read('bei Anna', [hit('Café Anna', 'Neubaugasse 2, 1070 Vienna')], events)).toEqual([
      ['Café Anna', 'search'],
    ]);
    const see = { address: 'See, Tyrol, Austria', lat: 47.0855, lng: 10.4667, name: 'See' };
    expect(read('am See', [see], events)).toEqual([]);
    const square = hit('Am Hof', 'Am Hof, 1010 Vienna, Austria');
    const town = { address: 'Hof, Bavaria, Germany', lat: 50.3135, lng: 11.9128, name: 'Hof' };
    expect(read('Am Hof', [town, square], events)).toEqual([['Am Hof', 'exact']]);
    expect(read('Am Hof', [town], events)).toEqual([]);
  });

  it('takes no search hit for a text that says only a kind of place', () => {
    // MapKit's answers in Vienna (probe, 2026-11-09): each resembles the
    // word and is nearby, and none is the place the user means.
    const zara = hit('Zara Home', 'Kärntner Straße 11, 1010 Vienna, Austria');
    const offices = hit(
      'The Vienna Philharmonic - Administrative Offices',
      'Bösendorferstraße 12, 1010 Vienna, Austria',
    );
    const bar = hit('The Office', 'Werdertorgasse 4, 1010 Vienna, Austria');
    const sacher = hit('Hotel Sacher Vienna', 'Philharmonikerstraße 4, 1010 Vienna, Austria');
    const buero = hit('Büro Konzept', 'Porzellangasse 36, 1090 Vienna, Austria');
    expect(read('home', [zara], events)).toEqual([['Zara Home', 'search']]);
    expect(read('office', [offices], events)).toEqual([
      ['The Vienna Philharmonic - Administrative Offices', 'search'],
    ]);
    expect(read('at the office', [bar], events)).toEqual([['The Office', 'search']]);
    expect(read('Hotel', [sacher], events)).toEqual([['Hotel Sacher Vienna', 'search']]);
    expect(read('im Büro', [buero], events)).toEqual([['Büro Konzept', 'search']]);
    // One called exactly that is still the one, as it was: a bar "The
    // Office", the city of Halle.
    expect(read('the office', [bar], events)).toEqual([['The Office', 'exact']]);
    const halle = { address: 'Halle, Germany', lat: 51.4828, lng: 11.9697, name: 'Halle' };
    expect(read('Halle', [halle], events)).toEqual([['Halle', 'exact']]);
    // A kind a town has one of names it, as it did (review, Opus).
    expect(
      read('airport', [hit('Vienna International Airport', '1300 Schwechat, Austria')], events),
    ).toEqual([['Vienna International Airport', 'words']]);
    expect(read('Flughafen', [hit('Flughafen Wien', '1300 Schwechat, Austria')], events)).toEqual([
      ['Flughafen Wien', 'words'],
    ]);
    expect(
      read('Uni', [hit('Universität Wien', 'Universitätsring 1, 1010 Vienna')], events),
    ).toEqual([['Universität Wien', 'words']]);
    // A name beside the kind is a place to find, and a compound may be one.
    expect(read('Hotel Sacher', [sacher], events)).toEqual([['Hotel Sacher Vienna', 'words']]);
    expect(
      read(
        'Konzerthaus',
        [hit('Wiener Konzerthaus', 'Lothringerstraße 20, 1030 Vienna, Austria')],
        events,
      ),
    ).toEqual([['Wiener Konzerthaus', 'words']]);
    expect(
      read('Schweizerhaus', [hit('Schweizerhaus', 'Prater 116, 1020 Vienna, Austria')], events),
    ).toEqual([['Schweizerhaus', 'exact']]);
  });

  it('takes a far place when the text says where it is', () => {
    const adlon = {
      address: 'Unter den Linden 77, 10117 Berlin, Germany',
      lat: 52.5159,
      lng: 13.3806,
      name: 'Hotel Adlon Kempinski Berlin',
    };
    expect(read('Hotel Adlon Berlin', [adlon], events)).toEqual([
      ['Hotel Adlon Kempinski Berlin', 'words'],
    ]);
    expect(read('Hotel Adlon', [adlon], events)).toEqual([
      ['Hotel Adlon Kempinski Berlin', 'search'],
    ]);
  });

  it('takes a city said on its own wherever it is', () => {
    // Review: "Berlin", said in Vienna, was a far namesake of itself.
    const berlin = { address: 'Berlin, Germany', lat: 52.52, lng: 13.405, name: 'Berlin' };
    const linz = {
      address: 'Linz, Upper Austria, Austria',
      lat: 48.3069,
      lng: 14.2858,
      name: 'Linz',
    };
    expect(read('Berlin', [berlin], events)).toEqual([['Berlin', 'exact']]);
    expect(read('Linz', [linz], events)).toEqual([['Linz', 'exact']]);
  });

  it('takes the nearby one of two namesakes, the far one only where the words say', () => {
    // Review: "Café Wien" said in Berlin took the Vienna café MapKit listed
    // first. Its name holds its city, which says nothing beside the name.
    const berlinUser = densestRegion([{ lat: 52.52, lng: 13.405 }]);
    const inVienna = {
      address: 'Hauptplatz 1, 1010 Wien, Österreich',
      lat: 48.21,
      lng: 16.37,
      name: 'Café Wien',
    };
    const inBerlin = {
      address: 'Kurfürstendamm 26, 10719 Berlin, Germany',
      lat: 52.5,
      lng: 13.33,
      name: 'Café Wien',
    };
    const lats = (text: string) =>
      rankFoundPlaces(text, [inVienna, inBerlin], berlinUser).map(({ match, place }) => [
        place.lat,
        match,
      ]);
    expect(lats('Café Wien')).toEqual([
      [inBerlin.lat, 'exact'],
      [inVienna.lat, 'search'],
    ]);
    // Said with its city, the far one is the one meant, in MapKit's order.
    expect(lats('Café Wien, Wien')[0]).toEqual([inVienna.lat, 'words']);
  });

  it('keeps home near when a trip’s events outnumber it', () => {
    // Review: two events in Lisbon and one at home made Vienna far.
    const lisbon = { lat: 38.7223, lng: -9.1393 };
    const trip = densestRegion([lisbon, lisbon, vienna]);
    expect(read('Cafe Meek', [benoni, kaffemik], trip)).toEqual([
      ['Kaffemik', 'phonetic'],
      ['Meek Café', 'search'],
    ]);
  });

  it('counts a zone’s part of the world as near, and everything without a region', () => {
    const cafeMik = {
      address: 'Hauptstraße 1, 10827 Berlin, Germany',
      lat: 52.48,
      lng: 13.35,
      name: 'Café MIK',
    };
    const zone = regionForTimeZone('Europe/Vienna');
    expect(read('Cafe Mik', [cafeMik, benoni], zone)).toEqual([['Café MIK', 'exact']]);
    // As it was before any region was known: every hit, the resembling first.
    expect(read('Cafe Meek', [london, benoni], undefined)).toEqual([
      ['Meek Café', 'words'],
      ['Meekhun Thai bistro', 'search'],
    ]);
  });
});

describe('withFoundSuggestions', () => {
  const berlin = {
    subtitle: 'Erich-Baron-Weg 83, Mahlsdorf, 12623 Berlin, Germany',
    title: 'kaffeemike',
  };
  const kaffemik = {
    address: 'Zollergasse 5, 1070 Vienna, Austria',
    lat: 48.2003,
    lng: 16.3497,
    name: 'Kaffemik',
  };
  const row = {
    coordinates: { lat: 48.2003, lng: 16.3497 },
    subtitle: 'Zollergasse 5, 1070 Vienna, Austria',
    title: 'Kaffemik',
  };

  it('lists the places the search found for the text before the completer’s rows', () => {
    // Observed 2026-11-06: typed "kaffeemik" offered only a namesake in Berlin.
    expect(withFoundSuggestions([berlin], [{ match: 'phonetic', place: kaffemik }], 6)).toEqual([
      row,
      berlin,
    ]);
  });

  it('leaves out what the search only happened to find, and a place without a name', () => {
    expect(
      withFoundSuggestions(
        [berlin],
        [
          { match: 'search', place: kaffemik },
          { match: 'words', place: { lat: 1, lng: 2 } },
        ],
        6,
      ),
    ).toEqual([berlin]);
  });

  it('lists a place both know once, where the completer put it, with its coordinates', () => {
    // MapKit's completer writes the city in the device's language.
    const completed = { subtitle: 'Zollergasse 5, 1070 Wien, Österreich', title: 'kaffemik' };
    const branch = { subtitle: 'Neubaugasse 1, 1070 Vienna, Austria', title: 'Kaffemik' };
    expect(
      withFoundSuggestions(
        [branch, completed, berlin],
        [
          { match: 'exact', place: kaffemik },
          { match: 'exact', place: kaffemik },
        ],
        6,
      ),
    ).toEqual([branch, row, berlin]);
    expect(
      withFoundSuggestions([branch, completed, berlin], [{ match: 'exact', place: kaffemik }], 2),
    ).toEqual([branch, row]);
  });

  it('keeps one chain’s branches in two cities apart', () => {
    // Review: one street and number in Boston and New York became one row.
    const newYork = { address: '1 Main St, New York', lat: 40.7, lng: -74, name: 'Starbucks' };
    const boston = { subtitle: '1 Main St, Boston', title: 'Starbucks' };
    expect(withFoundSuggestions([boston], [{ match: 'exact', place: newYork }], 6)).toEqual([
      { coordinates: { lat: 40.7, lng: -74 }, subtitle: '1 Main St, New York', title: 'Starbucks' },
      boston,
    ]);
  });

  it('lists one place once when the completer gave it twice', () => {
    // Review: two completer rows for one place became two identical rows.
    const one = { subtitle: 'Zollergasse 5, 1070 Vienna, Austria', title: 'Kaffemik' };
    const other = { subtitle: 'Zollergasse 5, Vienna', title: 'Kaffemik' };
    expect(withFoundSuggestions([one, other], [{ match: 'exact', place: kaffemik }], 6)).toEqual([
      row,
    ]);
  });

  it('keeps two buildings of one chain apart', () => {
    // Review: numbers run together made 1-2-34 and 1-23-4 one address.
    const shop = { address: '1-2-34 Shibuya, Tokyo', lat: 35.66, lng: 139.7, name: 'FamilyMart' };
    const other = { subtitle: '1-23-4 Shibuya, Tokyo', title: 'FamilyMart' };
    expect(withFoundSuggestions([other], [{ match: 'exact', place: shop }], 6)).toEqual([
      {
        coordinates: { lat: 35.66, lng: 139.7 },
        subtitle: '1-2-34 Shibuya, Tokyo',
        title: 'FamilyMart',
      },
      other,
    ]);
  });
});

const mapkit = (
  source: string,
  at: { lat: number; lng: number },
  address?: string,
): PlaceCandidate => ({
  ...(address ? { address } : {}),
  geo: new GeoLocation({ ...at, name: source, source }),
  match: 'words',
  source: 'mapkit',
});

describe('mergePlaceCandidates', () => {
  it('puts history first and lists each place once, however many searches found it', () => {
    const history = rankPastPlaces('Figlmüller', [figlmueller, lugeck]);
    const found = [
      mapkit('Figlmüller', { lat: 48.2001, lng: 16.3701 }, 'Wollzeile 5'),
      mapkit('Figlmüller Bäckerstrasse', { lat: 48.23, lng: 16.4 }, 'Bäckerstraße 6'),
      // The completer's row for the same place: the same text.
      mapkit('Figlmüller Bäckerstrasse', { lat: 48.2301, lng: 16.4001 }, 'Bäckerstraße 6'),
      mapkit('figlmüller', { lat: 48.25, lng: 16.45 }),
    ];
    expect(mergePlaceCandidates(history, found).map((c) => [c.source, c.geo.source])).toEqual([
      ['history', 'Figlmüller'],
      ['history', 'Figlmüller Lugeck'],
      ['mapkit', 'Figlmüller Bäckerstrasse'],
    ]);
    expect(mergePlaceCandidates([], found, 2)).toHaveLength(2);
  });

  it('keeps a branch around the corner that has a name of its own', () => {
    // Review: the real Figlmüllers are ~90 m apart; proximity alone merged them.
    const wollzeile = mapkit('Figlmüller', { lat: 48.209, lng: 16.375 }, 'Wollzeile 5');
    const baeckerstrasse = mapkit(
      'Figlmüller Bäckerstrasse',
      { lat: 48.2095, lng: 16.376 },
      'Bäckerstraße 6',
    );
    const twin = mapkit('Figlmüller', { lat: 48.2091, lng: 16.3751 }, 'Wollzeile 5');
    expect(
      mergePlaceCandidates([], [wollzeile, baeckerstrasse, twin]).map((c) => c.geo.source),
    ).toEqual(['Figlmüller', 'Figlmüller Bäckerstrasse']);
  });
});

const history = (source: string, match: PlaceCandidate['match']): PlaceCandidate => ({
  geo: new GeoLocation({ lat: 48.2, lng: 16.37, source }),
  match,
  source: 'history',
});
const found = (source: string, match: PlaceCandidate['match']): PlaceCandidate => ({
  geo: new GeoLocation({ lat: 48.2, lng: 16.37, name: source, source }),
  match,
  source: 'mapkit',
});

describe('preselectedPlace', () => {
  it('takes the best candidate that resembles the text, whatever ranks beside it', () => {
    expect(preselectedPlace([history('Café Central', 'phonetic')])?.geo.source).toBe(
      'Café Central',
    );
    expect(
      preselectedPlace([found('Figlmüller', 'words'), found('Figl', 'phonetic')])?.geo.source,
    ).toBe('Figlmüller');
    expect(preselectedPlace([found('Café Central', 'phonetic')])?.geo.source).toBe('Café Central');
    // Two ranking the same: the first still, the other a chip away.
    expect(preselectedPlace([found('A', 'words'), found('B', 'words')])?.geo.source).toBe('A');
  });

  it('takes nothing when the best is a hit that does not resemble the text', () => {
    expect(preselectedPlace([found('Kaffeeweg', 'search')])).toBeUndefined();
    expect(preselectedPlace([])).toBeUndefined();
  });
});

describe('placeCandidateLabel', () => {
  it('names a past place by its text and a search hit by name and address', () => {
    expect(
      placeCandidateLabel({
        geo: new GeoLocation({
          lat: 0,
          lng: 0,
          name: 'Figlmüller Wollzeile',
          source: 'Figlmüller',
        }),
        match: 'exact',
        source: 'history',
      }),
    ).toBe('Figlmüller');
    expect(
      placeCandidateLabel({
        address: 'Wollzeile 5, 1010 Vienna',
        geo: new GeoLocation({
          lat: 0,
          lng: 0,
          name: 'Figlmüller',
          source: 'Figlmüller, Wollzeile 5, 1010 Vienna',
        }),
        match: 'words',
        source: 'mapkit',
      }),
    ).toBe('Figlmüller · Wollzeile 5, 1010 Vienna');
  });
});
