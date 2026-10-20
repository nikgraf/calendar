import { GeoLocation } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { keptAsSaid, latestWord, locationToLookUp } from './editorLocation.ts';

const figl = new GeoLocation({ lat: 48.2, lng: 16.37, source: 'Figlmüller' });

describe('locationToLookUp', () => {
  it('looks up the text given, not one typed, pinned, or kept as said', () => {
    const given = { asSaid: '', geo: undefined, given: 'Figlmüller', location: 'Figlmüller' };
    expect(locationToLookUp(given)).toBe('Figlmüller');
    expect(locationToLookUp({ ...given, location: 'Figlmüller Lugeck' })).toBe('');
    expect(locationToLookUp({ ...given, geo: figl })).toBe('');
    const link = 'https://meet.example.com/abc';
    expect(locationToLookUp({ ...given, given: link, location: link })).toBe('');
    // Review: "As said" held only until the next turn gave the text again.
    expect(locationToLookUp({ ...given, asSaid: 'figlmüller' })).toBe('');
    // Another text given after it is looked up as any.
    expect(
      locationToLookUp({ ...given, asSaid: 'Figlmüller', given: 'Lugeck', location: 'Lugeck' }),
    ).toBe('Lugeck');
    expect(keptAsSaid('', '')).toBe(false);
  });
});

describe('latestWord', () => {
  it('lets a pick stand until a later word, and the later one then', () => {
    // Review: a pick answered after "As said" put the pin back on the same text.
    const word = latestWord();
    const pick = word.speak();
    expect(word.stands(pick)).toBe(true);
    const kept = word.speak();
    expect(word.stands(pick)).toBe(false);
    expect(word.stands(kept)).toBe(true);
  });
});
