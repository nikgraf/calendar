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

  it('lists a place both know once, with its coordinates, and stops at the limit', () => {
    const completed = { subtitle: 'Zollergasse 5, 1070 Vienna, Austria', title: 'kaffemik' };
    const branch = { subtitle: 'Neubaugasse 1, 1070 Vienna, Austria', title: 'Kaffemik' };
    expect(
      withFoundSuggestions(
        [completed, branch, berlin],
        [
          { match: 'exact', place: kaffemik },
          { match: 'exact', place: kaffemik },
        ],
        6,
      ),
    ).toEqual([row, branch, berlin]);
    expect(
      withFoundSuggestions([completed, branch, berlin], [{ match: 'exact', place: kaffemik }], 2),
    ).toEqual([row, branch]);
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
