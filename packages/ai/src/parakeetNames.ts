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
/** A word of the span this alike is the name's own, spelt another way ("Katarina" for Katharina). */
const SAME_WORD = 0.75;

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

/** Consonants only, a doubled one once: "li" and "lee" are both "l". */
const consonants = (text: string): string =>
  text.replaceAll(/[aeiouy\s]/gu, '').replaceAll(/(.)\1+/gu, '$1');

/** The span's words that are the name's own: for each word of the name, the likest span word at least `SAME_WORD` alike. */
const sharedWords = (
  said: ReadonlyArray<string>,
  name: ReadonlyArray<string>,
): { readonly name: ReadonlySet<number>; readonly said: ReadonlySet<number> } => {
  const fromSaid = new Set<number>();
  const fromName = new Set<number>();
  for (const [at, word] of name.entries()) {
    let best: { alike: number; at: number } | undefined;
    for (const [index, other] of said.entries()) {
      const alike = similarity(other, word);
      if (!fromSaid.has(index) && alike >= SAME_WORD && alike > (best?.alike ?? 0)) {
        best = { alike, at: index };
      }
    }
    if (best !== undefined) {
      fromSaid.add(best.at);
      fromName.add(at);
    }
  }
  return { name: fromName, said: fromSaid };
};

/**
 * Whether a replacement puts a name right rather than taking a word that
 * stood beside part of it. Where the span already says a word of the name,
 * spelt alike or nearly ("Anna in" → "Anna Lee", "Sara morgen" → "Sarah
 * Novak", "at Klein" → "David Klein"), the rest of the span has to sound
 * like the rest of the name: "Kapfmeder" for Karpfeneder, or the same
 * consonants for a short one ("Li" for Lee). A span that shares no word
 * with the name is Parakeet's to judge alone.
 */
export const putsNameRight = (from: string, to: string): boolean => {
  const said = words(from);
  const name = words(to);
  const shared = sharedWords(said, name);
  if (shared.name.size === 0) {
    return true;
  }
  const restSaid = said.filter((_, index) => !shared.said.has(index)).join(' ');
  const restName = name.filter((_, index) => !shared.name.has(index)).join(' ');
  return (
    similarity(restSaid, restName) >= REST_SIMILARITY ||
    (consonants(restSaid) !== '' && consonants(restSaid) === consonants(restName))
  );
};

const CLOSING = /[.,!?;:…)\]}"”»]*$/u;
const OPENING = /^[([{"“«¿¡]*/u;

/** Where `span` stands in `text` as whole words, outside the ranges taken already. */
const spanAt = (
  text: string,
  span: string,
  taken: ReadonlyArray<{ readonly end: number; readonly start: number }>,
): number | undefined => {
  for (let at = text.indexOf(span); at >= 0; at = text.indexOf(span, at + 1)) {
    const end = at + span.length;
    const whole =
      (at === 0 || /\s/u.test(text[at - 1] ?? '')) &&
      (end === text.length || /\s/u.test(text[end] ?? ''));
    if (whole && taken.every((range) => end <= range.start || at >= range.end)) {
      return at;
    }
  }
  return undefined;
};

/**
 * The phrase as Parakeet read it, with only the replacements that put a
 * name right (`putsNameRight`): its own text when it keeps them all, else
 * its words before the names with the kept ones put in where their spans
 * stand (whole words; FluidAudio lists them by how alike they are, not in
 * order), each keeping the punctuation around its span as Parakeet does.
 */
export const parakeetText = (reading: ParakeetReading): string => {
  if (reading.replacements.every(({ from, to }) => putsNameRight(from, to))) {
    return reading.text;
  }
  const spans: Array<{ end: number; start: number; to: string | undefined }> = [];
  for (const { from, to } of reading.replacements) {
    const start = spanAt(reading.raw, from, spans);
    if (start === undefined) {
      // Not among its words: the replacements cannot be told apart from the text.
      return reading.raw;
    }
    spans.push({ end: start + from.length, start, to: putsNameRight(from, to) ? to : undefined });
  }
  let text = '';
  let at = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const from = reading.raw.slice(span.start, span.end);
    const spanWords = from.split(' ');
    const replaced =
      span.to === undefined
        ? from
        : `${OPENING.exec(spanWords[0] ?? '')?.[0] ?? ''}${span.to}${CLOSING.exec(spanWords.at(-1) ?? '')?.[0] ?? ''}`;
    text += reading.raw.slice(at, span.start) + replaced;
    at = span.end;
  }
  return text + reading.raw.slice(at);
};
