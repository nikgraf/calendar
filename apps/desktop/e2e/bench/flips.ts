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
  // P(exactly i of total), from i = total down to the larger side.
  let exactly = 0.5 ** total;
  let tail = 0;
  for (let i = total; i >= larger; i -= 1) {
    tail += exactly;
    exactly = (exactly * i) / (total - i + 1);
  }
  return Math.min(1, 2 * tail);
};

/** Below this a split is called more than chance. */
const CHANCE = 0.05;

const probability = (p: number): string => (p < 0.005 ? 'p < 0.01' : `p = ${p.toFixed(2)}`);

const named = (
  label: string,
  flips: ReadonlyArray<Flip>,
  showBlind: boolean,
): string | undefined => {
  if (flips.length === 0) {
    return undefined;
  }
  const open = flips.filter((flip) => showBlind || !flip.blind).map((flip) => flip.id);
  const hidden = flips.length - open.length;
  return `   ${label}: ${[...(open.length === 0 ? [] : [open.join(', ')]), ...(hidden === 0 ? [] : [`${String(hidden)} blind`])].join(' · ')}`;
};

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
