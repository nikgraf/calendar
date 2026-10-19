import { describe, expect, it } from 'vite-plus/test';
import { GeoLocation } from '../types.ts';
import {
  mergePlaceCandidates,
  type PlaceCandidate,
  placeCandidateLabel,
  preselectedPlace,
  rankPastPlaces,
} from './candidates.ts';

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
    // Review: both texts for the same spot became two chips.
    // Both are exact for "Figlmüller" (one by text, one by MapKit's name): the later use stays.
    const wollzeile = past('Figlmüller Wollzeile', 5, 'Figlmüller', { lat: 48.2, lng: 16.3701 });
    expect(rankPastPlaces('Figlmüller', [wollzeile, figlmueller]).map((c) => c.geo.source)).toEqual(
      ['Figlmüller'],
    );
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
