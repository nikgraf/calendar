/**
 * What moved between two runs of one bench, and whether chance alone
 * would move as much. Both benches print it (`report.ts`, `finder.ts`).
 *
 * A blind case is counted and never named: its misses are not read when
 * briefs or prompts are written, so the table keeps them out of sight
 * (`MODEL_BENCH_BLIND=show` prints them, for fixing an expectation).
 */

export interface Flip {
  readonly blind: boolean;
  readonly id: string;
}

export interface Flips {
  /** Passed before, fails now. */
  readonly broke: ReadonlyArray<Flip>;
  /** Failed before, passes now. */
  readonly fixed: ReadonlyArray<Flip>;
}

/**
 * The exact two-sided sign test on the flips: how often a fair coin
 * splits `fixed + broke` tosses at least this unevenly. Cases that read
 * the same in both runs say nothing about which is better and are left
 * out, which is what makes two runs on the same cases a sharper measure
 * than their two scores.
 */
export const signTest = (fixed: number, broke: number): number => {
  const total = fixed + broke;
  if (total === 0) {
    return 1;
  }
  const larger = Math.max(fixed, broke);
  // The weight of each split against the even one's, which is 1: no power
  // of a half to underflow, however many cases flipped.
  const middle = Math.floor(total / 2);
  const weights: Array<number> = Array.from({ length: total + 1 }, () => 0);
  weights[middle] = 1;
  for (let i = middle + 1; i <= total; i += 1) {
    weights[i] = (weights[i - 1]! * (total - i + 1)) / i;
  }
  for (let i = middle - 1; i >= 0; i -= 1) {
    weights[i] = (weights[i + 1]! * (i + 1)) / (total - i);
  }
  const all = weights.reduce((sum, weight) => sum + weight, 0);
  const tail = weights.slice(larger).reduce((sum, weight) => sum + weight, 0);
  return Math.min(1, (2 * tail) / all);
};

/** Below this a split is called more than chance. */
const CHANCE = 0.05;

/** Three places near the line, so a p never reads the same on both sides of it. */
const probability = (p: number): string =>
  p < 0.0005 ? 'p < 0.001' : `p = ${p.toFixed(p < 0.1 ? 3 : 2)}`;

/** Cases by name, the blind ones as a count: what any list of cases prints. */
export const namedCases = (
  cases: ReadonlyArray<Flip>,
  { showBlind = false }: { readonly showBlind?: boolean | undefined } = {},
): string => {
  const open = cases.filter((each) => showBlind || !each.blind).map((each) => each.id);
  const hidden = cases.length - open.length;
  return [
    ...(open.length === 0 ? [] : [open.join(', ')]),
    ...(hidden === 0 ? [] : [`${String(hidden)} blind`]),
  ].join(' · ');
};

const named = (
  label: string,
  flips: ReadonlyArray<Flip>,
  showBlind: boolean,
): string | undefined =>
  flips.length === 0 ? undefined : `   ${label}: ${namedCases(flips, { showBlind })}`;

/** The flips as a comparison prints them: the open ones by name, the blind ones counted, then the test. */
export const flipLines = (
  { broke, fixed }: Flips,
  { showBlind = false }: { readonly showBlind?: boolean | undefined } = {},
): ReadonlyArray<string> => {
  if (fixed.length + broke.length === 0) {
    return [];
  }
  const p = signTest(fixed.length, broke.length);
  return [
    named('fixed', fixed, showBlind),
    named('broke', broke, showBlind),
    `   ${String(fixed.length)} fixed, ${String(broke.length)} broke: by chance alone ${probability(p)}, ${
      p < CHANCE ? 'more than chance' : 'not told apart from chance'
    }`,
  ].filter((line): line is string => line !== undefined);
};
