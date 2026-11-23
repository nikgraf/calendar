import { describe, expect, it } from 'vite-plus/test';
import {
  alignWords,
  alternativesFor,
  findWords,
  otherLanguageReading,
  readingsFor,
  wordsAt,
  wordsOf,
} from './readings.ts';
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
    expect(findWords(wordsOf('Café Prückel'), phrase)).toEqual([{ heard: [2, 4], words: [0, 2] }]);
    expect(findWords(wordsOf('Pruckle'), phrase)).toEqual([{ heard: [3, 4], words: [0, 1] }]);
  });

  it('finds the part of the words said now', () => {
    expect(findWords(wordsOf('Cafe Meek, Indiana'), wordsOf("It's in Indiana."))).toEqual([
      { heard: [2, 3], words: [2, 3] },
    ]);
  });

  it('finds words said twice in both places, in the order said', () => {
    expect(findWords(wordsOf('Kathamek'), wordsOf('Kathamek or maybe Kathamek'))).toEqual([
      { heard: [0, 1], words: [0, 1] },
      { heard: [3, 4], words: [0, 1] },
    ]);
  });

  it('keeps the longer of two runs as alike', () => {
    // Review: "Kathamek" is half like "Kaffemik", so "cafe" alone scored the same.
    expect(findWords(wordsOf('Café Kaffemik'), wordsOf('Lunch at the cafe Kathamek'))).toEqual([
      { heard: [3, 5], words: [0, 2] },
    ]);
  });

  it('looks past a short word for the name', () => {
    // Review: the exact "5" outscored the name, then stood for nothing.
    expect(
      findWords(wordsOf('Figlmüller, Wollzeile 5'), wordsOf('Dinner at Figelmiller at 5')),
    ).toEqual([{ heard: [2, 3], words: [0, 1] }]);
  });

  it('finds nothing for words nobody said, or a short word alone', () => {
    expect(findWords(wordsOf('Office'), wordsOf('Lunch tomorrow at one'))).toEqual([]);
    expect(findWords(wordsOf(''), wordsOf('Lunch'))).toEqual([]);
    // Review: a "6" said for the time stood for a whole address.
    expect(
      findWords(wordsOf('Figlmüller, Bäckerstraße 6, 1010 Wien'), wordsOf('Make it at 6')),
    ).toEqual([]);
  });
});

/** The words of `alternative` that read `segment`'s words `run`. */
const at = (segment: string, alternative: string, run: readonly [number, number]) => {
  const words = wordsOf(alternative);
  return wordsAt(alignWords(wordsOf(segment), words), run)?.map((index) => words[index]!.text);
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

  it('reads nothing where a word added at the edge could as well be its neighbour’s', () => {
    // "to" could as well be the start of "morrow"; "Figel" the end of "a".
    expect(at('Meek tomorrow', 'Mik to morrow', [0, 1])).toBeUndefined();
    expect(at('Dinner at Figelmiller', 'Dinner a Figel Miller', [2, 3])).toBeUndefined();
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

  it('reads every place the words were said', () => {
    // Review: the first of two equally alike places was the only one read.
    const twice = heard([
      { alternatives: ['Kathamek'], text: 'Kathamek' },
      { alternatives: [' or maybe'], text: ' or maybe' },
      { alternatives: [' Kathamek', ' Kaffamek'], text: ' Kathamek' },
    ]);
    expect(alternativesFor(twice, 'Kathamek')).toEqual(['Kaffamek']);
  });

  it('keeps an accent written decomposed with its letter', () => {
    // Review: "Café" in NFD lost its mark to the text after the span ("Kaffeé").
    const cafe = heard([{ alternatives: ['Café', 'Kaffee'], text: 'Café' }]);
    expect(alternativesFor(cafe, 'Cafe\u0301')).toEqual(['Kaffee']);
  });

  it('searches no part of an alternative', () => {
    // Review: "Miller" alone was searched, and a nearby Miller offered first.
    const split = heard([
      {
        alternatives: ['Dinner at Figelmiller', 'Dinner a Figel Miller'],
        text: 'Dinner at Figelmiller',
      },
    ]);
    expect(alternativesFor(split, 'Figelmiller')).toEqual([]);
  });

  it('reads both words of a place that only together are alike', () => {
    const cafe = heard([
      { text: 'Lunch at the cafe' },
      { alternatives: [' Kathamek.', ' Kaffemik.', ' Kafamek.'], text: ' Kathamek.' },
    ]);
    // "cafe Kaffemik" is the text itself, asked already.
    expect(alternativesFor(cafe, 'Café Kaffemik')).toEqual(['cafe Kafamek']);
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

// Each pair is one recording read twice (Nik, iPhone, 2026-11-23): by the
// English recogniser, and by the German one beside it.
const both = (text: string, other: string) => {
  const read = heardFromSegments([{ text }], other);
  if (read === undefined) {
    throw new Error('nothing heard');
  }
  return read;
};

describe('otherLanguageReading', () => {
  it('reads a name as the other language wrote it where it stood', () => {
    const naschmarkt = both(
      'Meet Tom Baker at the Nashmacht on Saturday at 10.',
      'Mit Tom Baker at the Naschmarkt on seday ten.',
    );
    expect(otherLanguageReading(naschmarkt, 'Nashmacht')).toBe('Naschmarkt');
    const praterstern = both(
      'Pick up David at Barathsten tomorrow at half past 5.',
      'Pickup, Davidat Praterstern Tomorrow, Half Past Five.',
    );
    expect(otherLanguageReading(praterstern, 'Barathsten')).toBe('Praterstern');
  });

  it('reads two words as the one the other language has, and one as two', () => {
    const platz = both(
      'Meet Stefan Muller, at Stefan Platz, today at 6.',
      'Miet Stephan Müllerat Stephansplatz todayat six.',
    );
    expect(otherLanguageReading(platz, 'Stefan Platz')).toBe('Stephansplatz');
    const cafe = both(
      'Coffee with Thomas Kapmeter at Café Bruke on Friday at free.',
      'Coffee with Thomas Carpmaderat Café Brückel und Fridayat Free.',
    );
    expect(otherLanguageReading(cafe, 'Café Bruke')).toBe('Café Brückel');
  });

  it('keeps what the model added to the words that were said', () => {
    const heard = both(
      'Walk with Anna and Shampun on Sunday morning.',
      'Walk with Anna in Schönbrunn und Sunday Morning.',
    );
    expect(otherLanguageReading(heard, 'Shampun, Vienna')).toBe('Schönbrunn, Vienna');
  });

  it('is nothing without another reading, for words nobody said, or the same words', () => {
    const heard = both('Lunch at Kaffemik tomorrow', 'Lunch at Kaffemik tomorrow');
    expect(otherLanguageReading(heard, 'Kaffemik')).toBeUndefined();
    expect(otherLanguageReading(heard, 'Plachutta')).toBeUndefined();
    const one = heardFromSegments([{ text: 'Lunch at Kaffemik tomorrow' }]);
    expect(one && otherLanguageReading(one, 'Kaffemik')).toBeUndefined();
  });

  it('takes no word only the other reading has at the start or the end of the phrase', () => {
    const end = both('Lunch at Nashmacht', 'Lunch am Naschmarkt bitte schön');
    expect(otherLanguageReading(end, 'Nashmacht')).toBeUndefined();
    const start = both('Nashmacht at 10', 'Am Naschmarkt um zehn');
    expect(otherLanguageReading(start, 'Nashmacht')).toBeUndefined();
  });

  it('is nothing when the other reading is one long word of a language without spaces', () => {
    const heard = both('Meet Tom tomorrow at Shinjuku', '明日新宿でトムに会う予定があります');
    expect(otherLanguageReading(heard, 'Shinjuku')).toBeUndefined();
  });

  it('is nothing when it reads the words as the model already spelled them', () => {
    const heard = both('Coffee at Cafe Pruckle tomorrow', 'Kaffee at Café Prückel morgen');
    expect(otherLanguageReading(heard, 'Café Prückel')).toBeUndefined();
  });

  it('is nothing for words said twice: which place is meant is not its to say', () => {
    const heard = both('From Nashmacht to Nashmacht', 'From Naschmarkt to Naschmarkt');
    expect(otherLanguageReading(heard, 'Nashmacht')).toBeUndefined();
  });
});

describe('readingsFor', () => {
  it('puts the other language’s reading right after the recogniser’s likeliest', () => {
    const read = heardFromSegments(
      [
        { text: 'Meet Tom at the' },
        { alternatives: [' Nashmacht', ' Nash market', ' Naschmarkt'], text: ' Nashmacht' },
      ],
      'Mit Tom at the Naschmarkt',
    );
    expect(read && readingsFor(read, 'Nashmacht')).toEqual(['Nash market', 'Naschmarkt']);
    // The recogniser's likeliest is the other language's too: it stays first.
    const agreed = heardFromSegments(
      [
        { text: 'Meet Tom at the' },
        { alternatives: [' Nashmacht', ' Naschmarkt', ' Nash market'], text: ' Nashmacht' },
      ],
      'Mit Tom at the Naschmarkt',
    );
    expect(agreed && readingsFor(agreed, 'Nashmacht')).toEqual(['Naschmarkt', 'Nash market']);
    const alone = heardFromSegments(
      [{ text: 'Meet Tom at the Nashmacht' }],
      'Mit Tom at the Naschmarkt',
    );
    expect(alone && readingsFor(alone, 'Nashmacht')).toEqual(['Naschmarkt']);
  });

  it('is the recogniser’s own readings without another language', () => {
    const read = heard([{ alternatives: ['at Kaffe Mik'], text: 'at Meek' }]);
    expect(readingsFor(read, 'Meek')).toEqual(alternativesFor(read, 'Meek'));
  });
});
