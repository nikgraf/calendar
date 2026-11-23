import type { SpikeClip } from './speechSpikeClips.ts';

/**
 * How the Speech Spike page scores what a recogniser wrote against the
 * sheet, the same way the Mac measurement did (2026-11-23): word error
 * rate over the words both sides normalise to, and whether the place and
 * each person named in full are written right once case, accents and ß
 * are folded away.
 *
 * Normalised alike on both sides: lower case, punctuation out (an
 * apostrophe too), `:` between words ("8:15" is "8 15"), and a number
 * said as a word becomes its digits, one word at a time ("one" → 1,
 * "zwölf" → 12, "fifth" → 5). Accents stay in the error rate: "Muller"
 * is not "Müller".
 */

const NUMBERS: Readonly<Record<string, string>> = Object.fromEntries([
  ...[
    'zero',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
    'thirteen',
    'fourteen',
    'fifteen',
    'sixteen',
    'seventeen',
    'eighteen',
    'nineteen',
    'twenty',
  ].map((word, n) => [word, String(n)]),
  ...[
    'null',
    'eins',
    'zwei',
    'drei',
    'vier',
    'fünf',
    'sechs',
    'sieben',
    'acht',
    'neun',
    'zehn',
    'elf',
    'zwölf',
  ].map((word, n) => [word, String(n)]),
  ['thirty', '30'],
  ['forty', '40'],
  ['fifty', '50'],
  ['fortysix', '46'],
  ['fifth', '5'],
  ['5th', '5'],
  ['fünften', '5'],
  ['zwanzig', '20'],
  ['dreißig', '30'],
  ['vierzig', '40'],
  ['sechsundvierzig', '46'],
]);

const normalWord = (raw: string): string => {
  const word = raw
    .normalize('NFC')
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}_-]/gu, '')
    .replaceAll(/^-+|-+$/gu, '')
    .replaceAll('-', '');
  return NUMBERS[word] ?? word;
};

/** The words of `text` as the score compares them. */
export const wordsOf = (text: string): ReadonlyArray<string> =>
  text.replaceAll(':', ' ').split(/\s+/u).map(normalWord).filter(Boolean);

/** Case, accents and ß folded away, for "written right". */
const fold = (word: string): string =>
  word
    .replaceAll('ß', 'ss')
    .replaceAll('ø', 'o')
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase();

/** The fewest words to put in, take out or change to make `heard` the `said`. */
export const editsBetween = (said: ReadonlyArray<string>, heard: ReadonlyArray<string>): number => {
  let previous = Array.from({ length: heard.length + 1 }, (_, j) => j);
  for (let i = 1; i <= said.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= heard.length; j += 1) {
      row.push(
        Math.min(
          (previous[j] ?? 0) + 1,
          (row[j - 1] ?? 0) + 1,
          (previous[j - 1] ?? 0) + (said[i - 1] === heard[j - 1] ? 0 : 1),
        ),
      );
    }
    previous = row;
  }
  return previous[heard.length] ?? 0;
};

/** Whether `phrase` stands in `text` as whole words, folded. */
export const writtenRight = (text: string, phrase: string): boolean => {
  const words = wordsOf(text).map(fold);
  const wanted = wordsOf(phrase).map(fold);
  // "St. Pölten" may be written "Sankt Pölten".
  const also = wanted[0] === 'st' ? [['sankt', ...wanted.slice(1)]] : [];
  // A name's last word may carry a possessive s ("Emily Carter's", written "Carters").
  const matches = (target: ReadonlyArray<string>, at: number) =>
    target.every((word, k) => {
      const heard = words[at + k];
      return heard === word || (k === target.length - 1 && heard === `${word}s`);
    });
  return [wanted, ...also].some((target) => words.some((_, at) => matches(target, at)));
};

/** One clip's score. */
export interface ClipScore {
  readonly edits: number;
  /** Each person named in full: written right or not, in the clip's order. */
  readonly people: ReadonlyArray<boolean>;
  /** Undefined where the clip names no place. */
  readonly place: boolean | undefined;
  /** The sheet's words. */
  readonly words: number;
}

export const scoreClip = (clip: SpikeClip, heard: string): ClipScore => {
  const said = wordsOf(clip.said);
  return {
    edits: editsBetween(said, wordsOf(heard)),
    people: clip.people.map((person) => writtenRight(heard, person)),
    place: clip.place === undefined ? undefined : writtenRight(heard, clip.place),
    words: said.length,
  };
};

/** A group's totals: the error rate over all its words, and the names written right of those named. */
export interface GroupScore {
  readonly clips: number;
  readonly people: { readonly named: number; readonly right: number };
  readonly places: { readonly named: number; readonly right: number };
  /** Undefined where no clip of the group ran (a run cut short). */
  readonly wordErrorRate: number | undefined;
}

export const scoreGroup = (scores: ReadonlyArray<ClipScore>): GroupScore => {
  const edits = scores.reduce((sum, score) => sum + score.edits, 0);
  const words = scores.reduce((sum, score) => sum + score.words, 0);
  const people = scores.flatMap((score) => score.people);
  const places = scores.flatMap((score) => (score.place === undefined ? [] : [score.place]));
  return {
    clips: scores.length,
    people: { named: people.length, right: people.filter(Boolean).length },
    places: { named: places.length, right: places.filter(Boolean).length },
    wordErrorRate: words === 0 ? undefined : edits / words,
  };
};
