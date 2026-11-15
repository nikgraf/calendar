import { foldSearchText } from '@calendar/core';
import type { Heard, TranscriptSegment } from './speech.ts';

/**
 * The other readings of a few words of a phrase, as the recogniser
 * weighed them. A recogniser reads a phrase in segments, and each comes
 * with the readings it weighed for it (`TranscriptSegment.alternatives`,
 * the first one the segment as written): "Lunch tomorrow at" and
 * "Kathamek." with "Kathamic.", "Kafamek.", "Kaffamek.". The words asked
 * about ("Kathamek", the place a model read in the phrase) are found
 * among the segments' words, and each alternative is lined up with its
 * segment word by word, so the words it has where they stood can be
 * taken out. Nothing here reads what a word means: words are compared by
 * their letters alone.
 */

/** One word: where it stands in its text, as written, and as compared. */
interface Word {
  readonly end: number;
  /** Folded (case, accents, ß), letters and digits only: what two words are compared by. */
  readonly key: string;
  readonly start: number;
  /** The word as written, without the punctuation around it. */
  readonly text: string;
}

const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** A text's words. A token with no letter or digit in it ("|", "—") is not one. */
export const wordsOf = (text: string): ReadonlyArray<Word> =>
  [...text.matchAll(/\S+/gu)].flatMap((token) => {
    const written = token[0].replaceAll(EDGE_PUNCTUATION, '');
    const key = foldSearchText(written)
      .replaceAll('ß', 'ss')
      .replaceAll(/[^\p{L}\p{N}]/gu, '');
    if (key === '') {
      return [];
    }
    const start = token.index + token[0].indexOf(written);
    return [{ end: start + written.length, key, start, text: written }];
  });

/** Letters to change, add or drop to turn one word into the other. */
const editDistance = (a: string, b: string): number => {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(
        row[j]! + 1,
        next[j - 1]! + 1,
        row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[b.length]!;
};

/** How alike two words are: 1 the same, 0 not a letter in place. */
export const likeness = (a: Word, b: Word): number =>
  a.key === b.key ? 1 : 1 - editDistance(a.key, b.key) / Math.max(a.key.length, b.key.length);

/**
 * One step from a segment's words to an alternative's: a word kept as
 * it is (`same`), read as another (`changed`), not in the alternative
 * (`dropped`), or only in it (`added`).
 */
export type Step =
  | { readonly from: number; readonly kind: 'changed' | 'same'; readonly to: number }
  | { readonly from: number; readonly kind: 'dropped' }
  | { readonly kind: 'added'; readonly to: number };

/**
 * The cheapest way from one list of words to another (edit distance over
 * words): a word read as another costs as much as the two differ, one
 * dropped or added a whole word.
 */
export const alignWords = (
  from: ReadonlyArray<Word>,
  to: ReadonlyArray<Word>,
): ReadonlyArray<Step> => {
  const cost = Array.from({ length: from.length + 1 }, (_, i) =>
    Array.from({ length: to.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= from.length; i += 1) {
    for (let j = 1; j <= to.length; j += 1) {
      cost[i]![j] = Math.min(
        cost[i - 1]![j - 1]! + 1 - likeness(from[i - 1]!, to[j - 1]!),
        cost[i - 1]![j]! + 1,
        cost[i]![j - 1]! + 1,
      );
    }
  }
  const steps: Array<Step> = [];
  let i = from.length;
  let j = to.length;
  while (i > 0 || j > 0) {
    const here = cost[i]![j]!;
    if (i > 0 && j > 0) {
      const like = likeness(from[i - 1]!, to[j - 1]!);
      if (Math.abs(here - (cost[i - 1]![j - 1]! + 1 - like)) < 1e-9) {
        steps.push({ from: i - 1, kind: like === 1 ? 'same' : 'changed', to: j - 1 });
        i -= 1;
        j -= 1;
        continue;
      }
    }
    if (i > 0 && Math.abs(here - (cost[i - 1]![j]! + 1)) < 1e-9) {
      steps.push({ from: i - 1, kind: 'dropped' });
      i -= 1;
    } else {
      steps.push({ kind: 'added', to: j - 1 });
      j -= 1;
    }
  }
  return steps.reverse();
};

/** Two runs of words found to be the same words: `[start, end)` in each. */
interface Found {
  readonly heard: readonly [number, number];
  readonly words: readonly [number, number];
}

/** A pair of words scores by how alike they are: +1 the same, -1 nothing alike, 0 half. */
const pairScore = (a: Word, b: Word): number => 2 * likeness(a, b) - 1;
/** A word on one side only. */
const GAP_SCORE = -1;
/** Less than this, the words are not among what was heard: one word three-quarters alike. */
const FOUND_SCORE = 0.5;

/**
 * Where some words stand among the words heard: the two runs most alike
 * (local alignment), so words the model took from an earlier turn ("Cafe
 * Meek, Vienna" when only "Vienna" was said now) or wrote another way
 * ("Café Prückel" for "Cafe Pruckle") still find the ones that were said.
 * Nothing when no run is alike enough.
 */
export const findWords = (
  words: ReadonlyArray<Word>,
  heard: ReadonlyArray<Word>,
): Found | undefined => {
  const score = Array.from({ length: words.length + 1 }, () =>
    Array.from({ length: heard.length + 1 }, () => 0),
  );
  let best = { i: 0, j: 0, score: 0 };
  for (let i = 1; i <= words.length; i += 1) {
    for (let j = 1; j <= heard.length; j += 1) {
      const value = Math.max(
        0,
        score[i - 1]![j - 1]! + pairScore(words[i - 1]!, heard[j - 1]!),
        score[i - 1]![j]! + GAP_SCORE,
        score[i]![j - 1]! + GAP_SCORE,
      );
      score[i]![j] = value;
      if (value > best.score) {
        best = { i, j, score: value };
      }
    }
  }
  if (best.score < FOUND_SCORE) {
    return undefined;
  }
  // Back to where the run began: the first pair after a zero.
  let { i, j } = best;
  let start = { i, j };
  while (i > 0 && j > 0 && score[i]![j]! > 0) {
    const here = score[i]![j]!;
    start = { i, j };
    if (Math.abs(here - (score[i - 1]![j - 1]! + pairScore(words[i - 1]!, heard[j - 1]!))) < 1e-9) {
      i -= 1;
      j -= 1;
    } else if (Math.abs(here - (score[i - 1]![j]! + GAP_SCORE)) < 1e-9) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return { heard: [start.j - 1, best.j], words: [start.i - 1, best.i] };
};

/** Whether a step belongs to the words `[from, to)` of its segment. */
const inside = (step: Step | undefined, [from, to]: readonly [number, number]): boolean =>
  step !== undefined && step.kind !== 'added' && step.from >= from && step.from < to;

/**
 * The words of an alternative that read the segment's words `[from, to)`:
 * the ones lined up with them, and the ones only the alternative has
 * between them. A word only the alternative has at the edge of the run
 * ("Kaffe" in "at Kaffe Mik" for "at Meek") joins it when the word on its
 * other side is read the same in both (or there is none): beside a word
 * that changed too, it could as well be that word's. Nothing when the
 * alternative has no words there.
 */
export const wordsAt = (
  steps: ReadonlyArray<Step>,
  run: readonly [number, number],
): ReadonlyArray<number> => {
  const taken: Array<number> = [];
  steps.forEach((step, at) => {
    if (step.kind === 'added') {
      const before = steps.slice(0, at).findLast((each) => each.kind !== 'added');
      const after = steps.slice(at + 1).find((each) => each.kind !== 'added');
      const edge = (other: Step | undefined) => other === undefined || other.kind === 'same';
      if (
        (inside(before, run) && inside(after, run)) ||
        (inside(after, run) && !inside(before, run) && edge(before)) ||
        (inside(before, run) && !inside(after, run) && edge(after))
      ) {
        taken.push(step.to);
      }
    } else if (step.kind !== 'dropped' && inside(step, run)) {
      taken.push(step.to);
    }
  });
  return taken;
};

/** One reading of a segment's part: its words as written, and how far down the recogniser's list. */
interface PartReading {
  readonly keys: string;
  readonly rank: number;
  readonly words: ReadonlyArray<string>;
}

/** Readings of one segment's part at most: the recogniser lists about five. */
const READINGS_PER_PART = 6;
/** Combinations kept while joining the parts: the best by rank. */
const BEAM = 32;

/**
 * Each reading of the words `[from, to)` of a segment: the segment's own
 * first, then each alternative's words there, once each, in the
 * recogniser's order.
 */
const partReadings = (
  segment: TranscriptSegment,
  run: readonly [number, number],
): ReadonlyArray<PartReading> => {
  const own = wordsOf(segment.text);
  const heard = own.slice(run[0], run[1]);
  const readings: Array<PartReading> = [
    { keys: heard.map((word) => word.key).join(' '), rank: 0, words: heard.map((w) => w.text) },
  ];
  for (const alternative of segment.alternatives ?? []) {
    const words = wordsOf(alternative);
    const taken = wordsAt(alignWords(own, words), run).map((at) => words[at]!);
    const keys = taken.map((word) => word.key).join(' ');
    if (taken.length > 0 && !readings.some((reading) => reading.keys === keys)) {
      readings.push({ keys, rank: readings.length, words: taken.map((word) => word.text) });
    }
    if (readings.length >= READINGS_PER_PART) {
      break;
    }
  }
  return readings;
};

/** The parts joined: every combination of the parts' readings, the likeliest first (lowest ranks). */
const combine = (
  parts: ReadonlyArray<ReadonlyArray<PartReading>>,
): ReadonlyArray<{ readonly rank: number; readonly words: ReadonlyArray<string> }> => {
  let joined: ReadonlyArray<{ readonly rank: number; readonly words: ReadonlyArray<string> }> = [
    { rank: 0, words: [] },
  ];
  for (const readings of parts) {
    joined = joined
      .flatMap((sofar) =>
        readings.map((reading) => ({
          rank: sofar.rank + reading.rank,
          words: [...sofar.words, ...reading.words],
        })),
      )
      // Stable: among equals, the last part's reading changes first.
      .sort((a, b) => a.rank - b.rank)
      .slice(0, BEAM);
  }
  return joined;
};

/** Other readings offered at most: each is a search. */
export const ALTERNATIVES_LIMIT = 4;

/** The segment and its words, each word with the phrase-wide index it has. */
const segmentWords = (
  segments: ReadonlyArray<TranscriptSegment>,
): ReadonlyArray<{ readonly at: number; readonly segment: number; readonly word: Word }> => {
  let at = 0;
  return segments.flatMap((segment, index) =>
    wordsOf(segment.text).map((word) => ({ at: at++, segment: index, word })),
  );
};

/**
 * The other readings of `text` among what was heard, the likeliest first:
 * `text` with the words it shares with the phrase read as the segments'
 * alternatives read them, the rest of it as it is ("Café Kathamek,
 * Vienna" → "Café Kaffamek, Vienna"). None when its words are not among
 * what was heard, or the recogniser weighed nothing else for them; never
 * `text` itself, nor two readings of the same words.
 */
export const alternativesFor = (
  heard: Heard,
  text: string,
  limit: number = ALTERNATIVES_LIMIT,
): ReadonlyArray<string> => {
  const own = wordsOf(text);
  const phrase = segmentWords(heard.segments);
  const found = findWords(
    own,
    phrase.map((entry) => entry.word),
  );
  if (found === undefined) {
    return [];
  }
  const said = phrase.slice(found.heard[0], found.heard[1]);
  // Each segment the words stand in, with the run of its words they take.
  const parts = [...new Set(said.map((entry) => entry.segment))].map((index) => {
    const first = phrase.findIndex((entry) => entry.segment === index);
    const mine = said.filter((entry) => entry.segment === index);
    return partReadings(heard.segments[index]!, [
      mine[0]!.at - phrase[first]!.at,
      mine.at(-1)!.at - phrase[first]!.at + 1,
    ]);
  });
  const before = text.slice(0, own[found.words[0]]!.start);
  const after = text.slice(own[found.words[1] - 1]!.end);
  const seen = new Set([own.map((word) => word.key).join(' ')]);
  const readings: Array<string> = [];
  for (const { rank, words } of combine(parts)) {
    const reading = `${before}${words.join(' ')}${after}`;
    const keys = wordsOf(reading)
      .map((word) => word.key)
      .join(' ');
    if (rank > 0 && !seen.has(keys)) {
      seen.add(keys);
      readings.push(reading);
    }
    if (readings.length >= limit) {
      break;
    }
  }
  return readings;
};
