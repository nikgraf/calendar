import { describe, expect, it } from 'vite-plus/test';
import { heardFromSegments, transcriptFromSegments } from './speech.ts';

describe('transcriptFromSegments', () => {
  it('joins segments into one phrase', () => {
    expect(transcriptFromSegments([{ text: 'Lunch with Sarah' }, { text: 'next Tuesday' }])).toBe(
      'Lunch with Sarah next Tuesday',
    );
  });

  it('collapses the whitespace recognisers leave around joins', () => {
    expect(transcriptFromSegments([{ text: '  Lunch   with ' }, { text: ' Sarah  ' }])).toBe(
      'Lunch with Sarah',
    );
  });

  it('returns undefined for silence, so nothing is parsed', () => {
    expect(transcriptFromSegments([])).toBeUndefined();
    expect(transcriptFromSegments([{ text: '' }, { text: '   ' }])).toBeUndefined();
  });

  it('keeps non-ASCII text intact', () => {
    expect(transcriptFromSegments([{ text: 'Zahnarzt nächsten Dienstag' }])).toBe(
      'Zahnarzt nächsten Dienstag',
    );
  });
});

describe('heardFromSegments', () => {
  it('keeps the segments and their other readings beside the phrase', () => {
    const segments = [
      { alternatives: ['Stefan at'], text: 'Coffee with Stefan had' },
      { text: 'Kaffemik' },
    ];
    expect(heardFromSegments(segments)).toEqual({
      segments,
      text: 'Coffee with Stefan had Kaffemik',
    });
  });

  it('is nothing for silence', () => {
    expect(heardFromSegments([{ text: '  ' }])).toBeUndefined();
  });
});
