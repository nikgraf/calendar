import { join } from 'node:path';
import { GeoLocation, type PlaceCandidate } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import {
  formatPlaceReport,
  isPlaceMeant,
  loadPlaceCases,
  locationHeard,
  outcomeOf,
  placeScore,
} from './places.ts';

const BENCH_DIR = import.meta.dirname;

const candidate = (name: string, extra: Partial<PlaceCandidate> = {}): PlaceCandidate => ({
  geo: new GeoLocation({ lat: 48.2, lng: 16.37, name, source: name }),
  match: 'words',
  source: 'mapkit',
  ...extra,
});

describe('places.json', () => {
  const cases = loadPlaceCases(join(BENCH_DIR, 'places.json'));

  it('reads every case', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it('names a place each case’s words hold: else no reading of it can be had', () => {
    expect(cases.filter((each) => !locationHeard(each)).map((each) => each.id)).toEqual([]);
  });
});

describe('isPlaceMeant', () => {
  it('takes a name that begins with one of the place’s, folded and without spaces', () => {
    expect(isPlaceMeant(candidate('Figlmüller Bäckerstrasse'), ['Figlmüller'])).toBe(true);
    expect(isPlaceMeant(candidate('Loosbar'), ['Loos Bar'])).toBe(true);
    expect(isPlaceMeant(candidate('Bleier-Figlmüller'), ['Figlmüller'])).toBe(false);
  });
});

describe('outcomeOf', () => {
  it('says whether the place meant was taken, where it was offered and by which reading', () => {
    const names = ['Figlmüller'];
    expect(outcomeOf([candidate('Figlmüller')], names)).toMatchObject({
      offered: 1,
      taken: true,
    });
    const byReading = outcomeOf(
      [
        candidate('Bleier-Figlmüller', { match: 'search' }),
        candidate('Figlmüller', { alternative: 'Figelmuller', match: 'phonetic' }),
      ],
      names,
    );
    expect(byReading).toMatchObject({ foundAs: 'Figelmuller', offered: 2, taken: false });
    expect(outcomeOf([candidate('Bleier-Figlmüller', { match: 'search' })], names)).toEqual({
      candidates: [{ match: 'search', name: 'Bleier-Figlmüller', source: 'mapkit' }],
      errors: [],
      taken: false,
    });
  });
});

describe('placeScore', () => {
  it('counts each arm, and the cases only a reading found', () => {
    const none = outcomeOf([], ['Kaffemik']);
    const found = outcomeOf(
      [candidate('Kaffemik', { alternative: 'Kaffeemik', match: 'phonetic' })],
      ['Kaffemik'],
    );
    const report = {
      cases: [
        {
          alternatives: ['Kaffeemik'],
          asWritten: none,
          id: 'a',
          location: 'Kaffamik',
          readings: found,
          said: 'at Kaffemik',
          voice: 'say',
        },
      ],
      sha: 'abc',
      when: '2026-11-15T00:00:00.000Z',
    };
    expect(placeScore(report.cases)).toEqual({
      asWritten: { offered: 0, taken: 0 },
      cases: 1,
      errors: 0,
      readings: { offered: 1, onlyByReading: 1, taken: 0 },
    });
    expect(formatPlaceReport(report)).toContain('“Kaffamik” → – | offered 1 as “Kaffeemik”');
  });
});
