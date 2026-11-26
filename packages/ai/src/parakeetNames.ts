/**
 * Parakeet's reading of a phrase (`ParakeetBridge.swift`): its words before
 * the names it listens for (`raw`), each span the names replaced, and the
 * words after (`text`).
 */
export interface ParakeetReading {
  readonly raw: string;
  readonly replacements: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly text: string;
}

/** Below this, the rest of a span is not the rest of the name (#384's recordings: wrong 0–0.20, right 0.50 and up). */
const REST_SIMILARITY = 0.5;

/** Lower case, without accents or punctuation, as words. */
const words = (text: string): ReadonlyArray<string> =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replaceAll(/\p{M}/gu, '')
    .replaceAll('ß', 'ss')
    .replaceAll(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);

const distance = (a: string, b: string): number => {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[b.length] ?? 0;
};

const similarity = (a: string, b: string): number => {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - distance(a, b) / longest;
};

/**
 * Whether a replacement puts a name right rather than taking a word that
 * stood beside part of it. Where the span already says a word of the name
 * ("Anna in" → "Anna Lee", "at Klein" → "David Klein"), the rest of the
 * span has to sound like the rest of the name ("Kapfmeder" for
 * Karpfeneder); a span that shares no word with the name is Parakeet's to
 * judge alone.
 */
export const putsNameRight = (from: string, to: string): boolean => {
  const said = words(from);
  const name = words(to);
  const shared = name.filter((word) => said.includes(word));
  if (shared.length === 0) {
    return true;
  }
  const restSaid = said.filter((word) => !shared.includes(word)).join(' ');
  const restName = name.filter((word) => !shared.includes(word)).join(' ');
  return similarity(restSaid, restName) >= REST_SIMILARITY;
};

const CLOSING = /[.,!?;:…)\]}"”»]*$/u;
const OPENING = /^[([{"“«¿¡]*/u;

/**
 * The phrase as Parakeet read it, with only the replacements that put a
 * name right (`putsNameRight`): its own text when it keeps them all, else
 * its words before the names with the kept ones put in, in order, each
 * keeping the punctuation around its span as Parakeet does.
 */
export const parakeetText = (reading: ParakeetReading): string => {
  const kept = reading.replacements.map(({ from, to }) => putsNameRight(from, to));
  if (kept.every(Boolean)) {
    return reading.text;
  }
  let text = '';
  let rest = reading.raw;
  for (const [index, { from, to }] of reading.replacements.entries()) {
    const at = rest.indexOf(from);
    if (at < 0) {
      // Not where its words were: the replacements cannot be told apart from the text.
      return reading.raw;
    }
    if (kept[index] === true) {
      const spanWords = from.split(' ');
      const opening = OPENING.exec(spanWords[0] ?? '')?.[0] ?? '';
      const closing = CLOSING.exec(spanWords.at(-1) ?? '')?.[0] ?? '';
      text += `${rest.slice(0, at)}${opening}${to}${closing}`;
    } else {
      text += rest.slice(0, at + from.length);
    }
    rest = rest.slice(at + from.length);
  }
  return text + rest;
};
