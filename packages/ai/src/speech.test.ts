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

  it('keeps the other language’s reading beside it, unless it wrote nothing', () => {
    const segments = [{ text: 'Meet Tom at the Nashmacht' }];
    expect(heardFromSegments(segments, 'Mit Tom at the Naschmarkt')).toEqual({
      other: 'Mit Tom at the Naschmarkt',
      segments,
      text: 'Meet Tom at the Nashmacht',
    });
    expect(heardFromSegments(segments, ' ')).toEqual({
      segments,
      text: 'Meet Tom at the Nashmacht',
    });
  });

  it('is Parakeet’s reading when it read the phrase, Apple’s beside it', () => {
    const segments = [{ alternatives: ['Thomas Karp'], text: 'Coffee with Thomas Kapmeader' }];
    expect(
      heardFromSegments(segments, 'Kaffee mit Thomas', ' Coffee with  Thomas Karpfeneder '),
    ).toEqual({
      apple: 'Coffee with Thomas Kapmeader',
      other: 'Kaffee mit Thomas',
      segments: [{ text: 'Coffee with Thomas Karpfeneder' }],
      text: 'Coffee with Thomas Karpfeneder',
    });
    // Parakeet wrote nothing: Apple's reading is the phrase, as without it.
    expect(heardFromSegments(segments, undefined, '  ')).toEqual({
      segments,
      text: 'Coffee with Thomas Kapmeader',
    });
  });

  it('is nothing for silence', () => {
    expect(heardFromSegments([{ text: '  ' }])).toBeUndefined();
    expect(heardFromSegments([{ text: '  ' }], 'Hm')).toBeUndefined();
    // Apple's recogniser decides silence: Parakeet's words alone are no phrase.
    expect(heardFromSegments([{ text: '  ' }], undefined, 'Hm')).toBeUndefined();
  });
});
