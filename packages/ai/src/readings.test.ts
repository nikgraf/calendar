import { describe, expect, it } from 'vite-plus/test';
import { alignWords, alternativesFor, findWords, wordsAt, wordsOf } from './readings.ts';
import { heardFromSegments, type TranscriptSegment } from './speech.ts';

const heard = (segments: ReadonlyArray<TranscriptSegment>) => {
  const read = heardFromSegments(segments);
  if (read === undefined) {
    throw new Error('nothing heard');
  }
  return read;
};

describe('wordsOf', () => {
  it('folds each word and drops the punctuation around it, and tokens with no letter', () => {
    expect(
      wordsOf(' Café, Prückel. | Lou’s +1 Straße').map(({ key, text }) => [text, key]),
    ).toEqual([
      ['Café', 'cafe'],
      ['Prückel', 'pruckel'],
      ['Lou’s', 'lous'],
      ['1', '1'],
      ['Straße', 'strasse'],
    ]);
  });

  it('keeps where each word stands in its text', () => {
    const [, cafe, meek] = wordsOf('at  "Cafe Meek",');
    expect(cafe).toMatchObject({ end: 9, start: 5 });
    expect(meek).toMatchObject({ end: 14, start: 10 });
  });
});

describe('alignWords', () => {
  it('reads a word as the one most like it and adds the rest', () => {
    // "Kaffe" is the word only the alternative has: "Meek" is read as "Mik".
    expect(alignWords(wordsOf('at Meek'), wordsOf('at Kaffe Mik'))).toEqual([
      { from: 0, kind: 'same', to: 0 },
      { kind: 'added', to: 1 },
      { from: 1, kind: 'changed', to: 2 },
    ]);
    expect(
      alignWords(wordsOf('Schweezer Hass on Saturday'), wordsOf('Schweezer, Hassan Saturday')),
    ).toEqual([
      { from: 0, kind: 'same', to: 0 },
      { from: 1, kind: 'changed', to: 1 },
      { from: 2, kind: 'dropped' },
      { from: 3, kind: 'same', to: 2 },
    ]);
  });
});

describe('findWords', () => {
  it('finds the words among the heard ones, alike or the same', () => {
    const phrase = wordsOf('Coffee at Cafe Pruckle tomorrow');
    expect(findWords(wordsOf('Café Prückel'), phrase)).toEqual({ heard: [2, 4], words: [0, 2] });
    expect(findWords(wordsOf('Pruckle'), phrase)).toEqual({ heard: [3, 4], words: [0, 1] });
  });

  it('finds the part of the words said now', () => {
    expect(findWords(wordsOf('Cafe Meek, Indiana'), wordsOf("It's in Indiana."))).toEqual({
      heard: [2, 3],
      words: [2, 3],
    });
  });

  it('finds nothing for words nobody said', () => {
    expect(findWords(wordsOf('Office'), wordsOf('Lunch tomorrow at one'))).toBeUndefined();
    expect(findWords(wordsOf(''), wordsOf('Lunch'))).toBeUndefined();
  });
});

/** The words of `alternative` that read `segment`'s words `run`. */
const at = (segment: string, alternative: string, run: readonly [number, number]) => {
  const words = wordsOf(alternative);
  return wordsAt(alignWords(wordsOf(segment), words), run).map((index) => words[index]!.text);
};

describe('wordsAt', () => {
  it('takes the words lined up with the run and those only the alternative has inside it', () => {
    expect(at('Figelmiller on', 'Figel Miller on', [0, 1])).toEqual(['Figel', 'Miller']);
    expect(at('Cafe Pruckle tomorrow', 'Kaffee Prückel tomorrow', [0, 2])).toEqual([
      'Kaffee',
      'Prückel',
    ]);
  });

  it('takes a word added at the run’s edge beside a word read the same', () => {
    expect(at('at Meek', 'at Kaffe Mik', [1, 2])).toEqual(['Kaffe', 'Mik']);
  });

  it('leaves a word added beside a word that changed too', () => {
    // "to" could as well be the start of "morrow".
    expect(at('Meek tomorrow', 'Mik to morrow', [0, 1])).toEqual(['Mik']);
  });

  it('takes nothing where the alternative has no words', () => {
    expect(at('at Meek', 'at', [1, 2])).toEqual([]);
  });
});

describe('alternativesFor', () => {
  // As macOS 27.2's SpeechTranscriber read `say` voices saying the names
  // (2026-11-15): the first alternative is the segment itself.
  const kaffemik = heard([
    { alternatives: ['Lunch tomorrow at'], text: 'Lunch tomorrow at' },
    {
      alternatives: [' Kathamek.', ' Kathamic.', ' Kafamek.', ' Kaffamek.', ' Kathmic.'],
      text: ' Kathamek.',
    },
  ]);

  it('reads the words as each alternative of their segment does, the likeliest first', () => {
    expect(alternativesFor(kaffemik, 'Kathamek')).toEqual([
      'Kathamic',
      'Kafamek',
      'Kaffamek',
      'Kathmic',
    ]);
    expect(alternativesFor(kaffemik, 'Kathamek', 2)).toEqual(['Kathamic', 'Kafamek']);
  });

  it('keeps the rest of the text as it is', () => {
    expect(alternativesFor(kaffemik, 'Café Kathamek, Vienna')).toEqual([
      'Café Kathamic, Vienna',
      'Café Kafamek, Vienna',
      'Café Kaffamek, Vienna',
      'Café Kathmic, Vienna',
    ]);
  });

  it('reads the part of a segment the words take', () => {
    const figlmueller = heard([
      { alternatives: ['Dinner at'], text: 'Dinner at' },
      {
        alternatives: [
          ' Figelmiller on',
          ' Figel Miller on',
          ' Fiegel Miller on',
          ' Figal Miller on',
        ],
        text: ' Figelmiller on',
      },
      { alternatives: [' Friday.', ' Friday'], text: ' Friday.' },
    ]);
    expect(alternativesFor(figlmueller, 'Figelmiller')).toEqual([
      'Figel Miller',
      'Fiegel Miller',
      'Figal Miller',
    ]);
  });

  it('joins the readings of every segment the words stand in, the lowest ranks first', () => {
    const loosBar = heard([
      { alternatives: ['Drinks at'], text: 'Drinks at' },
      { alternatives: [' Gloose', ' Loose', ' Glues', ' glues', ' loose'], text: ' Gloose' },
      { alternatives: [' Bar', ' bar'], text: ' Bar' },
      { alternatives: [' Friday at 7.'], text: ' Friday at 7.' },
    ]);
    // "Glues" and "glues", "Bar" and "bar" are one reading each.
    expect(alternativesFor(loosBar, 'Gloose Bar')).toEqual(['Loose Bar', 'Glues Bar']);
    const cafe = heard([
      { alternatives: ['Coffee at'], text: 'Coffee at' },
      { alternatives: [' Cafe', ' Kaffee'], text: ' Cafe' },
      { alternatives: [' Pruckle', ' Pruckl', ' Prückel'], text: ' Pruckle' },
    ]);
    expect(alternativesFor(cafe, 'Cafe Pruckle')).toEqual([
      'Cafe Pruckl',
      'Kaffee Pruckle',
      'Cafe Prückel',
      'Kaffee Pruckl',
    ]);
  });

  it('reads the words of the place the model wrote its own way', () => {
    const cafe = heard([
      { alternatives: ['Coffee at'], text: 'Coffee at' },
      { alternatives: [' Cafe', ' cafe'], text: ' Cafe' },
      { alternatives: [' Pruckle', ' Pruckl'], text: ' Pruckle' },
      { alternatives: [' tomorrow.', ' Tomorrow.'], text: ' tomorrow.' },
    ]);
    expect(alternativesFor(cafe, 'Café Prückel')).toEqual(['Cafe Pruckl']);
  });

  it('reads only the words said now of a place an earlier turn began', () => {
    const vienna = heard([
      { alternatives: ["It's in Indiana.", "It's in Vienna."], text: "It's in Indiana." },
    ]);
    expect(alternativesFor(vienna, 'Cafe Meek, Indiana')).toEqual(['Cafe Meek, Vienna']);
  });

  it('reads the fixture grammar’s place part', () => {
    const fixture = heard([
      { text: 'Dinner | +0 | 19:00-20:00 |' },
      { alternatives: [' Figelmiller', ' Figelmuller'], text: ' Figelmiller' },
    ]);
    expect(alternativesFor(fixture, 'Figelmiller')).toEqual(['Figelmuller']);
  });

  it('has nothing for words nobody said, or nothing else weighed', () => {
    expect(alternativesFor(kaffemik, 'Office')).toEqual([]);
    expect(alternativesFor(heard([{ text: 'Lunch at Kathamek' }]), 'Kathamek')).toEqual([]);
    expect(
      alternativesFor(
        heard([{ alternatives: [' Kathamek', ' kathamek.'], text: ' Kathamek' }]),
        'Kathamek',
      ),
    ).toEqual([]);
  });

  it('skips an alternative that drops the words', () => {
    expect(
      alternativesFor(
        heard([{ alternatives: ['at Meek', 'at', 'at Mik'], text: 'at Meek' }]),
        'Meek',
      ),
    ).toEqual(['Mik']);
  });
});
