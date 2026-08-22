import { describe, expect, it } from 'vitest';
import { transcriptFromSegments } from './speech.ts';

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
