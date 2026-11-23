import { describe, expect, it } from 'vite-plus/test';
import { SPIKE_CLIPS } from './speechSpikeClips.ts';
import { editsBetween, scoreClip, scoreGroup, wordsOf, writtenRight } from './speechSpikeScore.ts';

const clip = (id: string) => {
  const found = SPIKE_CLIPS.find((each) => each.id === id);
  if (found === undefined) {
    throw new Error(id);
  }
  return found;
};

describe('wordsOf', () => {
  it('normalises both sides alike: case, punctuation, clock times and numbers as words', () => {
    expect(wordsOf('Lunch with Sarah tomorrow at one at Figlmüller')).toEqual(
      wordsOf('lunch with Sarah, tomorrow at 1 at figlmüller.'),
    );
    expect(wordsOf('Train from Westbahnhof on Monday at 8:15.')).toEqual([
      'train',
      'from',
      'westbahnhof',
      'on',
      'monday',
      'at',
      '8',
      '15',
    ]);
    expect(wordsOf("Dinner at Emily Carter's")).toEqual(['dinner', 'at', 'emily', 'carters']);
    expect(wordsOf('am fünften Dezember um zwölf')).toEqual(['am', '5', 'dezember', 'um', '12']);
  });

  it('keeps accents in the error rate', () => {
    expect(editsBetween(wordsOf('Stefan Müller'), wordsOf('Stefan Muller'))).toBe(1);
  });
});

describe('editsBetween', () => {
  it('counts the words put in, taken out and changed', () => {
    expect(editsBetween(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(0);
    expect(editsBetween(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])).toBe(2);
    expect(editsBetween(['a', 'b'], [])).toBe(2);
    expect(editsBetween([], ['a'])).toBe(1);
  });
});

describe('writtenRight', () => {
  it('folds case, accents and ß, and wants whole words', () => {
    expect(writtenRight('Meet at the NASCHMARKT.', 'Naschmarkt')).toBe(true);
    expect(writtenRight('Shopping on Mariahilfer Strasse', 'Mariahilfer Straße')).toBe(true);
    expect(writtenRight('Meet Jorg Hofstatter', 'Jörg Hofstätter')).toBe(true);
    expect(writtenRight('Meet Jörg Hofstädter', 'Jörg Hofstätter')).toBe(false);
    expect(writtenRight('the Naschmarktstand', 'Naschmarkt')).toBe(false);
  });

  it('takes a name said with a possessive s', () => {
    expect(writtenRight("Dinner at Emily Carter's, Währinger Straße 46", 'Emily Carter')).toBe(
      true,
    );
    expect(writtenRight('Dinner with Emily Carters Werner Straße', 'Emily Carter')).toBe(true);
    expect(writtenRight('Dinner with Emily Cartersen', 'Emily Carter')).toBe(false);
  });

  it('scores every clip as said as right', () => {
    for (const each of SPIKE_CLIPS) {
      const score = scoreClip(each, each.said);
      expect(score.edits, each.id).toBe(0);
      expect(score.people.every(Boolean), each.id).toBe(true);
      expect(score.place ?? true, each.id).toBe(true);
    }
  });

  it('takes Sankt for St. and a number said as a word', () => {
    expect(writtenRight('Besprechung in Sankt Pölten', 'St. Pölten')).toBe(true);
    expect(writtenRight('Arzt in der Wollzeile fünf', 'Wollzeile 5')).toBe(true);
  });
});

describe('scoreClip and scoreGroup', () => {
  it('scores what Parakeet Ultra wrote on the Mac as the Mac did', () => {
    const scores = [
      // Mac, 2026-11-23: one edit ("Fiegelmüller"), place wrong.
      scoreClip(clip('place-en-01'), 'Lunch with Sarah tomorrow at 1 at Fiegelmüller.'),
      // Exact.
      scoreClip(clip('place-en-07'), 'Concert at Karlsplatz next Thursday at eight.'),
      // The person right, the place not.
      scoreClip(
        clip('place-en-27'),
        'Dinner with Jörg Hofstätter at Blahuta on Saturday at eight.',
      ),
    ];
    expect(scores.map((score) => score.edits)).toEqual([1, 0, 1]);
    expect(scores.map((score) => score.place)).toEqual([false, true, false]);
    expect(scores[2]?.people).toEqual([true]);
    expect(scoreGroup(scores)).toEqual({
      clips: 3,
      people: { named: 1, right: 1 },
      places: { named: 3, right: 1 },
      wordErrorRate: 2 / 25,
    });
  });
});
